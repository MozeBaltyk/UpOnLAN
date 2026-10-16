import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { X509Certificate } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const certs = require('../../services/assetCertificateServices');
let root; let caPem; let leafPem; let privateKey; let unrelatedPem;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Asset CA',
    '-addext', 'subjectAltName=DNS:asset.example', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-keyout', path.join(root, 'ca.key'), '-out', path.join(root, 'ca.crt')], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=leaf.example', '-keyout', path.join(root, 'leaf.key'), '-out', path.join(root, 'leaf.csr')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'leaf.ext'), 'subjectAltName=DNS:leaf.example\nbasicConstraints=critical,CA:FALSE\n');
  execFileSync('openssl', ['x509', '-req', '-in', path.join(root, 'leaf.csr'), '-CA', path.join(root, 'ca.crt'), '-CAkey', path.join(root, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', path.join(root, 'leaf.ext'), '-out', path.join(root, 'leaf.crt')], { stdio: 'ignore' });
  caPem = fs.readFileSync(path.join(root, 'ca.crt'), 'utf8');
  leafPem = fs.readFileSync(path.join(root, 'leaf.crt'), 'utf8');
  privateKey = fs.readFileSync(path.join(root, 'ca.key'), 'utf8');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Unrelated CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', path.join(root, 'unrelated.key'), '-out', path.join(root, 'unrelated.crt')], { stdio: 'ignore' });
  unrelatedPem = fs.readFileSync(path.join(root, 'unrelated.crt'), 'utf8');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('explicit CA bundles', () => {
  it('normalizes, describes, sorts, and deduplicates public CA certificates', () => {
    const parsed = certs.parseBundle(`${caPem}\n${caPem}`);
    expect(parsed.certificates).toHaveLength(1);
    expect(parsed.certificates[0]).toMatchObject({ ca: true, validity: 'current', selfSigned: true });
    expect(parsed.certificates[0].fingerprint256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
    expect(certs.mergeBundles(parsed.pem, caPem)).toBe(parsed.pem);
  });

  it('rejects leaves, private keys, trailing text, malformed PEM, and limits', () => {
    expect(() => certs.parseBundle(leafPem)).toThrowError(expect.objectContaining({ code: 'CERTIFICATE_NOT_CA' }));
    expect(() => certs.parseBundle(caPem + privateKey)).toThrowError(expect.objectContaining({ code: 'CERTIFICATE_PRIVATE_KEY' }));
    expect(() => certs.parseBundle(caPem + ' trailing')).toThrowError(expect.objectContaining({ code: 'CERTIFICATE_INVALID' }));
    expect(() => certs.parseBundle('-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----')).toThrowError(expect.objectContaining({ code: 'CERTIFICATE_INVALID' }));
    expect(() => certs.parseBundle(caPem.repeat(certs.MAX_CERTIFICATES + 1))).toThrowError(expect.objectContaining({ code: 'CERTIFICATE_INVALID' }));
  });
});

describe('TLS endpoint inspection', () => {
  function connection(remoteAddress = '192.0.2.10', presentedPem = caPem) {
    const cert = new X509Certificate(presentedPem);
    const socket = new EventEmitter();
    socket.remoteAddress = remoteAddress; socket.authorized = false; socket.authorizationError = 'self-signed certificate'; socket.destroy = () => {};
    const peer = { raw: cert.raw, fingerprint256: cert.fingerprint256, issuerCertificate: null }; peer.issuerCertificate = peer;
    socket.getPeerCertificate = () => peer;
    setImmediate(() => socket.emit('secureConnect'));
    return socket;
  }

  it('connects only to the resolved address and reports bounded public metadata and stored matches', async () => {
    let options;
    const result = await certs.inspectEndpoint({ origin: 'https://asset.example/', storedPem: caPem,
      lookup: async () => [{ address: '192.0.2.10', family: 4 }], connect: (value) => { options = value; return connection(); } });
    expect(options).toMatchObject({ host: '192.0.2.10', servername: 'asset.example', rejectUnauthorized: false });
    expect(result.metadata).toMatchObject({ hostnameMatch: true, validity: 'current', storedMismatch: false, systemTrusted: false, address: '192.0.2.10' });
    expect(result.caPem).toContain('BEGIN CERTIFICATE');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY|ca\.key/);
  });

  it.each(['127.0.0.1', '169.254.169.254', '100.100.100.200', '168.63.129.16', '::1', 'fd00:ec2::254', '::ffff:192.0.2.10'])('blocks prohibited address %s before connecting', async (address) => {
    let connected = false;
    await expect(certs.inspectEndpoint({ origin: 'https://asset.example/', lookup: async () => [{ address }], connect: () => { connected = true; } }))
      .rejects.toMatchObject({ code: 'CERTIFICATE_ADDRESS_BLOCKED' });
    expect(connected).toBe(false);
  });

  it('rejects a connected peer that differs from the pinned DNS answer', async () => {
    await expect(certs.inspectEndpoint({ origin: 'https://asset.example/', lookup: async () => [{ address: '192.0.2.10', family: 4 }], connect: () => connection('192.0.2.11') }))
      .rejects.toMatchObject({ code: 'CERTIFICATE_REBINDING' });
  });

  it('recognizes a stored CA that signs a leaf even when the endpoint omits the root', async () => {
    const result = await certs.inspectEndpoint({ origin: 'https://leaf.example/', storedPem: caPem,
      lookup: async () => [{ address: '192.0.2.10', family: 4 }], connect: () => connection('192.0.2.10', leafPem) });
    expect(result.metadata).toMatchObject({ hostnameMatch: true, storedMismatch: false });
    expect(result.caPem).toBe('');
  });

  it('uses an additional CA only when it signs the omitted-root chain', async () => {
    const inspect = (additionalPem) => certs.inspectEndpoint({ origin: 'https://leaf.example/', additionalPem,
      lookup: async () => [{ address: '192.0.2.10', family: 4 }], connect: () => connection('192.0.2.10', leafPem) });
    await expect(inspect(caPem)).resolves.toMatchObject({ metadata: { hostnameMatch: true, validity: 'current', additionalCaMatch: true } });
    await expect(inspect(unrelatedPem)).resolves.toMatchObject({ metadata: { additionalCaMatch: false } });
  });

  it('falls back on transport failure only when the local deployment certificate is current and matches the origin', async () => {
    const configRoot = path.join(root, 'config'); fs.mkdirSync(path.join(configRoot, 'tls'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'tls/server.crt'), caPem);
    const unavailable = () => { const socket = new EventEmitter(); socket.destroy = () => {}; return socket; };
    const fallback = await certs.inspectEndpoint({ origin: 'https://asset.example/', configRoot, timeoutMs: 5,
      lookup: async () => [{ address: '192.0.2.10', family: 4 }], connect: unavailable });
    expect(fallback).toMatchObject({ caPem: expect.stringContaining('BEGIN CERTIFICATE'), metadata: {
      endpointVerified: false, source: 'local deployment certificate', hostnameMatch: true,
      validity: 'current', localCertificateMatch: true, storedMismatch: false,
    } });
    expect(JSON.stringify(fallback)).not.toMatch(/PRIVATE KEY/);
    await expect(certs.inspectEndpoint({ origin: 'https://other.example/', configRoot,
      lookup: async () => { throw new Error('dns'); } })).rejects.toMatchObject({ code: 'CERTIFICATE_DNS_FAILED' });
  });

  it('does not replace a reachable endpoint hostname mismatch with the local certificate', async () => {
    const configRoot = path.join(root, 'config'); fs.mkdirSync(path.join(configRoot, 'tls'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'tls/server.crt'), caPem);
    await expect(certs.inspectEndpoint({ origin: 'https://leaf.example/', configRoot,
      lookup: async () => [{ address: '192.0.2.10', family: 4 }], connect: () => connection() }))
      .resolves.toMatchObject({ metadata: { endpointVerified: true, hostnameMatch: false, source: 'live endpoint' } });
  });
});
