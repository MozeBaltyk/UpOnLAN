'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const { createHash, X509Certificate } = require('crypto');

const MAX_BUNDLE_BYTES = 256 * 1024;
const MAX_CERT_BYTES = 64 * 1024;
const MAX_CERTIFICATES = 16;
const DEFAULT_TIMEOUT_MS = 5000;
const ROOTFS_STATUS = 'additionalTrustBundle configures OKD trust; it does not prove that iPXE or the Agent early initramfs trusts a private CA.';
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 3]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['::1', 128], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');
for (const address of ['100.100.100.200', '168.63.129.16']) blocked.addAddress(address, 'ipv4');
blocked.addAddress('fd00:ec2::254', 'ipv6');

function coded(message, code) { return Object.assign(new Error(message), { code }); }
function fingerprint(cert) { return createHash('sha256').update(cert.raw).digest('hex'); }
function allowedAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
function metadata(cert, now = Date.now()) {
  return {
    subject: cert.subject, issuer: cert.issuer, subjectAltName: cert.subjectAltName || '',
    validFrom: cert.validFrom, validTo: cert.validTo,
    validity: now < Date.parse(cert.validFrom) ? 'not_yet_valid' : now > Date.parse(cert.validTo) ? 'expired' : 'current',
    fingerprint256: fingerprint(cert), ca: cert.ca,
    selfSigned: cert.subject === cert.issuer && cert.verify(cert.publicKey),
  };
}
function parseBundle(input, { requireCA = true, now = Date.now() } = {}) {
  if (input === '' || input === null || input === undefined) return { pem: '', certificates: [] };
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_BUNDLE_BYTES) throw coded('Certificate bundle exceeds 256 KiB.', 'CERTIFICATE_INVALID');
  if (PRIVATE_KEY.test(input)) throw coded('Private keys are not accepted.', 'CERTIFICATE_PRIVATE_KEY');
  const blocks = input.match(PEM_CERT) || [];
  if (!blocks.length || blocks.length > MAX_CERTIFICATES || input.replace(PEM_CERT, '').trim()) throw coded('Enter PEM certificate blocks only (16 maximum).', 'CERTIFICATE_INVALID');
  const unique = new Map();
  for (const block of blocks) {
    if (Buffer.byteLength(block) > MAX_CERT_BYTES) throw coded('An individual certificate exceeds 64 KiB.', 'CERTIFICATE_INVALID');
    let cert; try { cert = new X509Certificate(block); } catch { throw coded('A PEM certificate is malformed.', 'CERTIFICATE_INVALID'); }
    if (requireCA && !cert.ca) throw coded('Every explicitly added certificate must be a CA certificate.', 'CERTIFICATE_NOT_CA');
    unique.set(fingerprint(cert), cert);
  }
  const certs = [...unique.values()];
  for (const cert of certs) {
    const issuers = certs.filter((candidate) => candidate !== cert && candidate.subject === cert.issuer);
    if (issuers.length && !issuers.some((issuer) => issuer.ca && cert.checkIssued(issuer) && cert.verify(issuer.publicKey))) throw coded('Certificate bundle chain signature is invalid.', 'CERTIFICATE_CHAIN_INVALID');
  }
  certs.sort((a, b) => fingerprint(a).localeCompare(fingerprint(b)));
  return { pem: certs.map((cert) => `${cert.toString().trim()}\n`).join(''), certificates: certs.map((cert) => metadata(cert, now)) };
}
function mergeBundles(...values) { return parseBundle(values.filter(Boolean).join('\n')).pem; }

function localCertificate(configRoot) {
  const file = path.join(configRoot, 'tls', 'server.crt');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_BUNDLE_BYTES) return null;
    return parseBundle(fs.readFileSync(fd, 'utf8'), { requireCA: false });
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function localFallback(url, hostname, configRoot, now, storedPem, additionalPem) {
  const local = localCertificate(configRoot);
  if (!local || !local.pem) return null;
  const certificates = (local.pem.match(PEM_CERT) || []).map((block) => new X509Certificate(block));
  const leaf = certificates.find((cert) => net.isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname, { subject: 'never' }));
  if (!leaf || certificates.some((cert) => now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo))) return null;
  const chain = []; const seen = new Set(); let current = leaf;
  while (current && !seen.has(fingerprint(current))) {
    chain.push(current); seen.add(fingerprint(current));
    if (current.subject === current.issuer) break;
    current = certificates.find((candidate) => candidate.ca && current.checkIssued(candidate) && current.verify(candidate.publicKey));
  }
  const root = chain[chain.length - 1];
  if (!root || !root.ca || root.subject !== root.issuer || !root.verify(root.publicKey) || seen.size !== certificates.length) return null;
  const caPem = chain.filter((cert) => cert.ca).map((cert) => `${cert.toString().trim()}\n`).join('');
  if (!caPem) return null;
  const stored = (parseBundle(storedPem, { requireCA: false }).pem.match(PEM_CERT) || []).map((block) => new X509Certificate(block));
  const storedMatch = stored.some((cert) => chain.some((item) => fingerprint(item) === fingerprint(cert)
    || (cert.ca && item.checkIssued(cert) && item.verify(cert.publicKey))));
  const additional = (parseBundle(additionalPem).pem.match(PEM_CERT) || []).map((block) => new X509Certificate(block));
  const additionalCaMatch = additional.some((ca) => now >= Date.parse(ca.validFrom) && now <= Date.parse(ca.validTo)
    && chain.some((item) => item.checkIssued(ca) && item.verify(ca.publicKey)));
  return { origin: url.toString(), pem: chain.map((cert) => `${cert.toString().trim()}\n`).join(''), caPem: parseBundle(caPem).pem,
    metadata: { available: false, endpointVerified: false, source: 'local deployment certificate', hostname, address: '', hostnameMatch: true,
      validity: 'current', systemTrusted: false, authorizationError: 'Endpoint was not reachable; live TLS was not verified.',
      localCertificateMatch: true, additionalCaMatch, storedMismatch: stored.length > 0 && !storedMatch,
      chain: chain.map((cert) => metadata(cert, now)), rootfsVerification: ROOTFS_STATUS } };
}
function localTrust(chain, configRoot) {
  const local = localCertificate(configRoot);
  if (!local) return { match: false, pem: '' };
  const localPrints = new Set(local.certificates.map((cert) => cert.fingerprint256));
  const match = chain.some((cert) => localPrints.has(cert.fingerprint256));
  return { match, pem: match ? parseBundle(local.pem, { requireCA: false }).pem : '' };
}

async function inspectEndpoint({ origin, configRoot = process.env.UPONLAN_CONFIG || '/config', lookup = dns.promises.lookup,
  connect = tls.connect, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now(), storedPem = '', additionalPem = '' } = {}) {
  let url;
  try { url = new URL(require('./localAssetSettings').validateOrigin(origin)); } catch { throw coded('Asset server URL must be a credential-free HTTPS root origin.', 'PUBLIC_URL_INVALID'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, ''); const port = Number(url.port || 443);
  const timeout = Math.max(1, Math.min(15000, timeoutMs)); const deadline = Date.now() + timeout;
  let answers; let lookupTimer;
  try {
    answers = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { lookupTimer = setTimeout(() => reject(coded('TLS certificate inspection timed out.', 'CERTIFICATE_TIMEOUT')), timeout); lookupTimer.unref(); }),
    ]);
  } catch (err) {
    const failure = err.code === 'CERTIFICATE_TIMEOUT' ? err : coded('Asset server hostname could not be resolved.', 'CERTIFICATE_DNS_FAILED');
    return localFallback(url, hostname, configRoot, now, storedPem, additionalPem) || Promise.reject(failure);
  }
  finally { clearTimeout(lookupTimer); }
  const addresses = [...new Map((Array.isArray(answers) ? answers : [answers]).slice(0, 32).map((item) => [item.address, item])).values()];
  if (!addresses.length || addresses.some((item) => !allowedAddress(item.address))) throw coded('Asset server resolves to a prohibited address.', 'CERTIFICATE_ADDRESS_BLOCKED');
  let lastError; let endpointError;
  for (const answer of addresses) {
    try {
      return await new Promise((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { reject(coded('TLS certificate inspection timed out.', 'CERTIFICATE_TIMEOUT')); return; }
        let settled = false;
        const socket = connect({ host: answer.address, port, family: answer.family || net.isIP(answer.address), servername: net.isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: false, checkServerIdentity: () => undefined });
        const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); err ? reject(err) : resolve(value); };
        const timer = setTimeout(() => finish(coded('TLS certificate inspection timed out.', 'CERTIFICATE_TIMEOUT')), remaining); timer.unref();
        socket.once('error', () => finish(coded('TLS certificate inspection failed.', 'CERTIFICATE_CONNECT_FAILED')));
        socket.once('secureConnect', () => {
          const peer = socket.remoteAddress;
          if (!peer || peer.replace(/^::ffff:/, '') !== answer.address.replace(/^::ffff:/, '') || !allowedAddress(peer)) { finish(coded('TLS peer address changed after DNS resolution.', 'CERTIFICATE_REBINDING')); return; }
          const chain = []; const seen = new Set(); let current = socket.getPeerCertificate(true);
          try {
            let chainBytes = 0;
            while (current && current.raw && !seen.has(current.fingerprint256)) {
              if (chain.length >= MAX_CERTIFICATES) throw coded('Presented certificate chain is too large.', 'CERTIFICATE_CHAIN_LIMIT');
              seen.add(current.fingerprint256); const cert = new X509Certificate(current.raw);
              if (cert.raw.length > MAX_CERT_BYTES) throw coded('Presented certificate is too large.', 'CERTIFICATE_CHAIN_LIMIT');
              chainBytes += cert.raw.length;
              if (chainBytes > MAX_BUNDLE_BYTES) throw coded('Presented certificate chain is too large.', 'CERTIFICATE_CHAIN_LIMIT');
              chain.push(cert); current = current.issuerCertificate;
            }
            if (!chain.length) throw coded('TLS endpoint presented no certificate.', 'CERTIFICATE_INVALID');
            for (let i = 0; i + 1 < chain.length; i += 1) if (!chain[i + 1].ca || !chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) throw coded('Presented certificate chain signature is invalid.', 'CERTIFICATE_CHAIN_INVALID');
            const leaf = chain[0]; const hostnameMatch = !!(net.isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { subject: 'never' }));
            const publicChain = chain.map((cert) => metadata(cert, now));
            const presentedCaPem = chain.filter((cert) => cert.ca).map((cert) => `${cert.toString().trim()}\n`).join('');
            const local = localTrust(publicChain, configRoot);
            const localCaPem = local.pem ? (local.pem.match(PEM_CERT) || []).filter((block) => new X509Certificate(block).ca).join('\n') : '';
            const caPem = parseBundle(`${presentedCaPem}${localCaPem}`, { requireCA: true }).pem;
            const storedBundle = parseBundle(storedPem, { requireCA: false });
            const stored = (storedBundle.pem.match(PEM_CERT) || []).map((block) => new X509Certificate(block));
            const presentedPrints = new Set(publicChain.map((cert) => cert.fingerprint256));
            const storedMatch = stored.some((storedCert) => presentedPrints.has(fingerprint(storedCert))
              || (storedCert.ca && chain.some((presented) => presented.checkIssued(storedCert) && presented.verify(storedCert.publicKey))));
            const storedMismatch = stored.length > 0 && !storedMatch;
            const additional = (parseBundle(additionalPem).pem.match(PEM_CERT) || []).map((block) => new X509Certificate(block));
            const additionalCaMatch = additional.some((ca) => now >= Date.parse(ca.validFrom) && now <= Date.parse(ca.validTo)
              && chain.some((presented) => presented.checkIssued(ca) && presented.verify(ca.publicKey)));
            finish(null, { origin: url.toString(), pem: chain.map((cert) => `${cert.toString().trim()}\n`).join(''), caPem,
              metadata: { available: true, endpointVerified: true, source: 'live endpoint', hostname, address: answer.address, hostnameMatch, validity: publicChain.some((cert) => cert.validity === 'not_yet_valid') ? 'not_yet_valid' : publicChain.some((cert) => cert.validity === 'expired') ? 'expired' : 'current',
                systemTrusted: !!socket.authorized, authorizationError: socket.authorized ? null : String(socket.authorizationError || 'untrusted'),
                 localCertificateMatch: local.match, additionalCaMatch, storedMismatch, chain: publicChain, rootfsVerification: ROOTFS_STATUS } });
          } catch (err) { finish(err.code ? err : coded('Presented certificate chain is invalid.', 'CERTIFICATE_INVALID')); }
        });
      });
    } catch (err) {
      lastError = err;
      if (!['CERTIFICATE_CONNECT_FAILED', 'CERTIFICATE_TIMEOUT'].includes(err.code)) endpointError = err;
    }
  }
  if (endpointError) throw endpointError;
  const fallback = localFallback(url, hostname, configRoot, now, storedPem, additionalPem);
  if (fallback) return fallback;
  throw lastError || coded('TLS certificate inspection failed.', 'CERTIFICATE_CONNECT_FAILED');
}

module.exports = { MAX_BUNDLE_BYTES, MAX_CERTIFICATES, ROOTFS_STATUS, allowedAddress, parseBundle, mergeBundles, inspectEndpoint };
