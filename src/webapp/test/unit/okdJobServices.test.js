import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const { createJobService, renderConfigs, makeRedactor } = require('../../services/okdJobServices.js');
const { COMPATIBILITY_RECORD } = require('../../services/okdServices.js');
const certificates = require('../../services/assetCertificateServices.js');
const release = COMPATIBILITY_RECORD.release;
let root;

const profile = {
  id: 'lab-okd', revision: 'a'.repeat(64), release, boot_mode: 'iso', asset_url: '', asset_certificate_bundle: '', additional_ca_bundle: '',
  platform: 'none', topology: 'sno', cluster_name: 'lab', base_domain: 'example.com', machine_network: '192.168.7.0/24', rendezvous_ip: '192.168.7.10',
  ssh_public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8n96vOlUzgA2V4ueqs5IWkvw/kffw52WC3Mpr7J2Cu fixture', worker_count: 0, api_vip: '', ingress_vip: '',
  hosts: [{ hostname: 'master-0', role: 'control-plane', mac: '02:00:00:00:00:10', ipv4: '192.168.7.10', interface: 'eno1', disk_hint: 'serial:disk-1' }],
};
const metadata = { archiveSha256: 'b'.repeat(64), binarySha256: 'c'.repeat(64) };
function child(pid = 4321) { const proc = new EventEmitter(); proc.pid = pid; proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); return proc; }
function identity(record) { return { profileId: record.profileId, release: record.release, mediaVersion: record.mediaVersion }; }
function service(overrides = {}) {
  return createJobService({
    configRoot: path.join(root, 'config'), logsRoot: path.join(root, 'logs'), persistenceReady: true,
    pullSecretService: { resolve: async () => ({ raw: '{"auths":{"quay.io":{"auth":"private-auth"}}}', parsed: { auths: { 'quay.io': { auth: 'private-auth' } } } }) },
    getProfile: async () => profile, getTemplates: async () => ({ ...renderConfigs(profile), revision: profile.revision }),
    getVerifiedInstaller: async () => ({ path: '/verified/openshift-install', metadata }), getVerifiedOc: async () => ({ path: '/verified/oc', metadata }),
    finalizeArtifacts: async ({ job }) => ({ versionId: job.mediaVersion }), ...overrides,
  });
}
async function wait(svc) { for (let i = 0; svc.isActive() && i < 100; i += 1) await new Promise((resolve) => setTimeout(resolve, 2)); }

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'okd-jobs-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('saved-mode generation', () => {
  it('uses the saved ISO mode, ignores browser mode input, and keeps extra trust in private input', async () => {
    const trusted = { ...profile, additional_ca_bundle: '' }; const proc = child(); let invocation; let workspace; let finalized;
    const svc = service({ getProfile: async () => trusted, getTemplates: async () => renderConfigs(trusted),
      spawnProcess: (_command, args, options) => { invocation = args; workspace = options.cwd; return proc; }, finalizeArtifacts: async (request) => { finalized = request; return { versionId: request.job.mediaVersion }; } });
    const started = await svc.start({ profileId: profile.id, revision: profile.revision, mode: 'pxe', confirmed: true });
    expect(started).toMatchObject({ mediaVersion: 'v1', release, mode: 'iso', destinationUrl: null });
    expect(invocation).toEqual(['agent', 'create', 'image', '--dir', workspace]);
    expect(yaml.load(fs.readFileSync(path.join(workspace, 'agent-config.yaml'), 'utf8'))).not.toHaveProperty('bootArtifactsBaseURL');
    expect(fs.readFileSync(path.join(workspace, 'install-config.yaml'), 'utf8')).toContain('private-auth');
    proc.emit('close', 0, null); await wait(svc);
    expect(finalized).toMatchObject({ mode: 'iso', publicBaseUrl: null, job: { mediaVersion: 'v1' } });
    expect((await svc.status()).history[0]).toMatchObject({ state: 'succeeded', versionId: 'v1', mediaVersion: 'v1' });
  });

  it('injects the exact immutable profile-owned PXE URL', async () => {
    const pxe = { ...profile, boot_mode: 'pxe', asset_url: 'https://boot.example:8443/' }; const proc = child(); let workspace;
    const original = certificates.inspectEndpoint; certificates.inspectEndpoint = async () => ({ metadata: { hostnameMatch: true, validity: 'current', storedMismatch: false, systemTrusted: true, localCertificateMatch: false } });
    try {
      const svc = service({ getProfile: async () => pxe, getTemplates: async () => renderConfigs(pxe), spawnProcess: (_command, args, options) => { expect(args[2]).toBe('pxe-files'); workspace = options.cwd; return proc; } });
      const started = await svc.start({ profileId: pxe.id, revision: pxe.revision, confirmed: true, mode: 'iso' });
      expect(started.destinationUrl).toBe(`https://boot.example:8443/okd/lab-okd/${release}/v1/`);
      expect(yaml.load(fs.readFileSync(path.join(workspace, 'agent-config.yaml'), 'utf8')).bootArtifactsBaseURL).toBe(`https://boot.example:8443/okd/lab-okd/${release}/v1`);
      proc.emit('close', 1, null); await wait(svc);
    } finally { certificates.inspectEndpoint = original; }
  });

  it('accepts saved local deployment trust when the live endpoint remains unavailable', async () => {
    const pxe = { ...profile, boot_mode: 'pxe', asset_url: 'https://boot.example/', asset_certificate_bundle: 'saved-public-ca' };
    const original = certificates.inspectEndpoint;
    certificates.inspectEndpoint = async () => ({ metadata: { endpointVerified: false, source: 'local deployment certificate',
      hostnameMatch: true, validity: 'current', storedMismatch: false, systemTrusted: false, localCertificateMatch: true, additionalCaMatch: false } });
    try {
      await expect(service({ getProfile: async () => pxe }).preflight(pxe.id, pxe.revision)).resolves.toMatchObject({ ready: true });
    } finally { certificates.inspectEndpoint = original; }
  });
});

describe('media identity and lifecycle', () => {
  it('allocates monotonic vN values and never reuses a setup-failure gap', async () => {
    let fail = true; const realWrite = fs.promises.writeFile.bind(fs.promises);
    const failed = service({ writeJobFile: async (file, ...args) => { if (fail && file.endsWith('agent-config.yaml')) { fail = false; throw new Error('setup'); } return realWrite(file, ...args); } });
    await expect(failed.start({ profileId: profile.id, revision: profile.revision, confirmed: true })).rejects.toThrow('setup');
    const proc = child(); const next = service({ spawnProcess: () => proc }); const started = await next.start({ profileId: profile.id, revision: profile.revision, confirmed: true });
    expect(started.mediaVersion).toBe('v2'); proc.emit('close', 1, null); await wait(next);
    const thirdProc = child(); const third = service({ spawnProcess: () => thirdProc }); expect((await third.start({ profileId: profile.id, revision: profile.revision, confirmed: true })).mediaVersion).toBe('v3'); thirdProc.emit('close', 1, null); await wait(third);
  });

  it('allows only one generation across service instances and releases the lock on completion', async () => {
    const firstChild = child(1001); const secondChild = child(1002);
    const first = service({ spawnProcess: () => firstChild }); const second = service({ spawnProcess: () => secondChild });
    const record = await first.start({ profileId: profile.id, revision: profile.revision, confirmed: true });
    await expect(second.start({ profileId: profile.id, revision: profile.revision, confirmed: true })).rejects.toMatchObject({ code: 'JOB_ACTIVE' });
    firstChild.emit('close', 1, null); await wait(first);
    expect((await second.start({ profileId: profile.id, revision: profile.revision, confirmed: true })).mediaVersion).toBe('v2');
    secondChild.emit('close', 1, null); await wait(second);
  });

  it('reclaims a stale generation lock after restart', async () => {
    const lock = path.join(root, 'config/okd/generation.lock'); fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, started: '1', token: 'stale' }));
    const proc = child(); const svc = service({ spawnProcess: () => proc });
    expect((await svc.start({ profileId: profile.id, revision: profile.revision, confirmed: true })).mediaVersion).toBe('v1');
    proc.emit('close', 1, null); await wait(svc); expect(fs.existsSync(lock)).toBe(false);
  });

  it('cancels and reads logs only by exact profile/release/vN identity', async () => {
    const proc = child(9876); const signals = []; const svc = service({ spawnProcess: () => proc, cancelTimeoutMs: 5,
      killGroup: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') queueMicrotask(() => proc.emit('close', null, signal)); } });
    const started = await svc.start({ profileId: profile.id, revision: profile.revision, confirmed: true }); proc.stdout.write('safe line\n');
    await expect(svc.cancel({ ...identity(started), mediaVersion: 'v9' })).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
    const cancelled = await svc.cancel(identity(started)); await wait(svc); expect(signals).toEqual([[9876, 'SIGTERM'], [9876, 'SIGKILL']]);
    expect(cancelled).toMatchObject({ state: 'cancelled' });
    expect((await svc.readLog(identity(started))).text).toContain('safe line');
    await expect(svc.readLog({ ...identity(started), release: '../bad' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await svc.status()).history[0]).toMatchObject({ state: 'cancelled', mediaVersion: 'v1' });
  });

  it('bounds and sanitizes logs and public records', async () => {
    const proc = child(); const svc = service({ spawnProcess: () => proc }); const started = await svc.start({ profileId: profile.id, revision: profile.revision, confirmed: true });
    const workspace = path.join(root, 'config/okd/workspaces/lab-okd', release, started.mediaVersion);
    proc.stderr.write('auth=private-'); proc.stderr.write(`auth\nworkspace=${workspace}\npassword=hunter2\n`); proc.stdout.write('x'.repeat(300000)); proc.emit('close', 7, null); await wait(svc);
    const log = await svc.readLog(identity(started), 999999); expect(Buffer.byteLength(log.text)).toBeLessThanOrEqual(64 * 1024); expect(log.truncated).toBe(true);
    const stored = fs.readFileSync(path.join(root, 'logs/okd', `lab-okd--${release}--v1.log`), 'utf8'); expect(stored).not.toMatch(/private-auth|hunter2|workspaces/);
    expect(JSON.stringify(await svc.status())).not.toMatch(/private-auth|pullSecret|workspace/);
  });

  it('marks valid persisted active generations interrupted without signalling stale PIDs', async () => {
    const jobs = path.join(root, 'config/okd/jobs'); fs.mkdirSync(jobs, { recursive: true }); const id = `lab-okd--${release}--v4`;
    fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({ profileId: 'lab-okd', profileRevision: 'a'.repeat(64), mediaVersion: 'v4', release, mode: 'iso', state: 'running', createdAt: '2026-01-01T00:00:00Z', releaseImage: COMPATIBILITY_RECORD.releaseImage, releaseDigest: COMPATIBILITY_RECORD.releaseDigest, compatibilityRevision: COMPATIBILITY_RECORD.revision, installerArchiveSha256: 'b'.repeat(64), installerBinarySha256: 'c'.repeat(64) }));
    let signalled = false; const svc = service({ killGroup: () => { signalled = true; } }); await svc.initialize();
    expect((await svc.status()).history[0]).toMatchObject({ state: 'interrupted', mediaVersion: 'v4' }); expect(signalled).toBe(false);
  });

  it('emits minimal generation audit identity', async () => {
    const events = []; const proc = child(); const svc = service({ spawnProcess: () => proc, auditEvent: async (...args) => events.push(args) });
    const started = await svc.start({ profileId: profile.id, revision: profile.revision, confirmed: true }); proc.emit('close', 0, null); await wait(svc);
    expect(events.at(-1)).toEqual(['generation.result', 'succeeded', { profileId: 'lab-okd', release, mediaVersion: started.mediaVersion, mode: 'iso' }]);
  });
});

describe('redaction', () => {
  it('redacts exact values split across chunks', () => {
    const redactor = makeRedactor('{"auth":"abc123"}', { auth: 'abc123' }); const output = redactor.feed('auth=abc') + redactor.feed('123\n') + redactor.flush();
    expect(output).not.toContain('abc123'); expect(output).toContain('[REDACTED]');
  });
});
