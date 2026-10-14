import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createOperationsService } = require('../../services/okdOperationsServices.js');
const { COMPATIBILITY_RECORD } = require('../../services/okdServices.js');
let root;
const id = '12345678-1234-1234-1234-123456789abc';
const profile = { id: 'lab-okd', revision: 'a'.repeat(64), hosts: [{}], release: COMPATIBILITY_RECORD.release, cluster_name: 'lab', base_domain: 'example.com' };
const version = { profileId: profile.id, versionId: id, jobId: id, release: COMPATIBILITY_RECORD.release, profileRevision: 'a'.repeat(64), mode: 'pxe' };

function child() {
  const proc = new EventEmitter(); proc.pid = 4321; proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); return proc;
}
function writeJob(state = 'succeeded', finishedAt = '2020-01-01T00:00:00.000Z') {
  const dir = path.join(root, 'config', 'okd', 'jobs'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, profileId: profile.id, profileRevision: version.profileRevision, state, createdAt: '2020-01-01T00:00:00.000Z', startedAt: '2020-01-01T00:00:00.000Z', finishedAt,
    release: COMPATIBILITY_RECORD.release, releaseImage: COMPATIBILITY_RECORD.releaseImage, releaseDigest: COMPATIBILITY_RECORD.releaseDigest,
    compatibilityRevision: COMPATIBILITY_RECORD.revision, installerArchiveSha256: 'b'.repeat(64), installerBinarySha256: 'c'.repeat(64),
    mode: 'pxe', versionId: id, errorCode: null, log: `${id}.log`, message: 'done',
  }));
}
function writeWorkspace() {
  const dir = path.join(root, 'config', 'okd', 'workspaces', profile.id, id); fs.mkdirSync(dir, { recursive: true }); return dir;
}
function service(overrides = {}) {
  return createOperationsService({
    configRoot: path.join(root, 'config'), assetsRoot: path.join(root, 'assets'), logsRoot: path.join(root, 'logs'),
    publicBaseUrl: 'https://pxe.example.com/', persistenceReady: true, retentionDays: '30', record: COMPATIBILITY_RECORD,
    getProfile: async () => profile, listProfiles: async () => [profile], listVersions: async () => [version],
    getToolStatus: async () => ({ tools: { installer: { ready: true }, oc: { ready: true } } }),
    getVerifiedInstaller: async () => ({ path: '/verified/openshift-install' }), getVerifiedOc: async () => ({ path: '/verified/oc' }),
    romManifestIdentity: () => 'b'.repeat(64), ...overrides,
  });
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'okd-operations-')); fs.mkdirSync(path.join(root, 'assets')); fs.mkdirSync(path.join(root, 'logs')); writeJob(); writeWorkspace(); process.env.UNRELATED_SECRET = 'do-not-inherit'; });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.UNRELATED_SECRET; });

describe('OKD operations monitoring and health', () => {
  it('uses only the pinned wait command, private workspace, no KUBECONFIG, and a redacted bounded log', async () => {
    const proc = child(); let invocation;
    const svc = service({ spawnProcess: (...args) => { invocation = args; return proc; } });
    const started = await svc.startMonitor({ profileId: profile.id, versionId: id });
    const workspace = writeWorkspace();
    expect(started).toMatchObject({ profileId: profile.id, versionId: id, state: 'running' });
    expect(invocation[0]).toBe('/verified/openshift-install');
    expect(invocation[1]).toEqual(['agent', 'wait-for', 'install-complete', '--dir', workspace]);
    expect(invocation[2]).toMatchObject({ cwd: workspace, shell: false, detached: true });
    expect(invocation[2].env).not.toHaveProperty('KUBECONFIG');
    expect(invocation[2].env).not.toHaveProperty('WEBAPP_USER'); expect(invocation[2].env).not.toHaveProperty('WEBAPP_PASS'); expect(invocation[2].env).not.toHaveProperty('UNRELATED_SECRET');
    proc.stdout.write(`workspace=${workspace} to`); proc.stdout.write('ken=very-'); proc.stdout.write('secret-token\n'); proc.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await svc.monitorStatus()).toMatchObject({ state: 'succeeded', message: 'Installation completed.' });
    const log = (await svc.readMonitorLog()).text;
    expect(log).not.toContain(workspace); expect(log).not.toContain('very-secret-token');
  });

  it('bounds timeout with TERM then KILL-compatible terminal handling and marks restart interruption', async () => {
    const proc = child(); const signals = [];
    const svc = service({ spawnProcess: () => proc, monitorTimeoutMs: 5, cancelTimeoutMs: 5, killGroup: (_pid, signal) => { signals.push(signal); if (signal === 'SIGTERM') proc.emit('close', null, signal); } });
    await svc.startMonitor({ profileId: profile.id, versionId: id }); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals[0]).toBe('SIGTERM'); expect((await svc.monitorStatus()).state).toBe('timed_out');

    const stateFile = path.join(root, 'config', 'okd', 'monitor.json');
    fs.writeFileSync(stateFile, JSON.stringify({ profileId: profile.id, versionId: id, jobId: id, state: 'running', startedAt: new Date().toISOString() }));
    const restarted = service(); await restarted.initialize(); expect((await restarted.monitorStatus()).state).toBe('interrupted');
  });

  it('cancels monitoring with TERM and bounded KILL escalation', async () => {
    const proc = child(); const signals = [];
    const svc = service({ spawnProcess: () => proc, cancelTimeoutMs: 5, killGroup: (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') proc.emit('close', null, signal); } });
    await svc.startMonitor({ profileId: profile.id, versionId: id });
    await svc.cancelMonitor(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']); expect((await svc.monitorStatus()).state).toBe('cancelled');
  });

  it('returns only aggregate health and handles absent kubeconfig safely', async () => {
    const svc = service();
    expect(await svc.health({ profileId: profile.id, versionId: id })).toMatchObject({ ready: false, reason: 'kubeconfig_not_ready' });
    const auth = path.join(writeWorkspace(), 'auth'); fs.mkdirSync(auth); fs.writeFileSync(path.join(auth, 'kubeconfig'), 'private-token');
    const calls = [];
    const healthy = service({ execProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[1] === 'nodes') return { stdout: JSON.stringify({ items: [{ metadata: { name: 'private-node' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] }) };
      return { stdout: JSON.stringify({ items: ['authentication', 'etcd', 'ingress', 'kube-apiserver', 'network', 'openshift-apiserver'].map((name) => ({ metadata: { name }, status: { conditions: [{ type: 'Available', status: 'True' }, { type: 'Progressing', status: 'False' }, { type: 'Degraded', status: 'False' }] } })) }) };
    } });
    const result = await healthy.health({ profileId: profile.id, versionId: id });
    expect(result).toMatchObject({ ready: true, querySucceeded: true, nodes: { total: 1, ready: 1 }, operators: { total: 6, available: 6, degraded: 0 } });
    expect(calls.map((call) => call.args)).toEqual([['get', 'nodes', '-o=json'], ['get', 'clusteroperators.config.openshift.io', '-o=json']]);
    expect(calls.every((call) => call.options.env.KUBECONFIG === path.join(auth, 'kubeconfig') && call.options.shell === false)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|kubeconfig|token|path/i);
  });

  it('rejects monitoring while generation is active and clears after async startup persistence failure', async () => {
    await expect(service({ isGenerationActive: () => true }).startMonitor({ profileId: profile.id, versionId: id })).rejects.toMatchObject({ code: 'OPERATION_ACTIVE' });
    const proc = child(); const signals = []; let renames = 0;
    const svc = service({ spawnProcess: () => proc, cancelTimeoutMs: 5, renameMonitorRecord: async (from, to) => {
      renames += 1; await Promise.resolve(); if (renames === 2) throw new Error('persist'); await fs.promises.rename(from, to);
    }, killGroup: (_pid, signal) => { signals.push(signal); if (signal === 'SIGTERM') queueMicrotask(() => proc.emit('close', null, signal)); } });
    await expect(svc.startMonitor({ profileId: profile.id, versionId: id })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals[0]).toBe('SIGTERM'); expect(svc.isMonitorActive()).toBe(false); expect((await svc.monitorStatus()).state).toMatch(/failed/);
  });

  it('distinguishes zero/degraded query results from readiness and rejects revision drift before probing', async () => {
    const auth = path.join(writeWorkspace(), 'auth'); fs.mkdirSync(auth); fs.writeFileSync(path.join(auth, 'kubeconfig'), 'dummy');
    const empty = service({ execProcess: async () => ({ stdout: '{"items":[]}' }) });
    expect(await empty.health({ profileId: profile.id, versionId: id })).toMatchObject({ querySucceeded: true, ready: false, reason: 'cluster_not_ready', nodes: { expected: 1, total: 0 } });
    const degraded = service({ execProcess: async (_command, args) => ({ stdout: JSON.stringify({ items: args[1] === 'nodes'
      ? [{ status: { conditions: [{ type: 'Ready', status: 'True' }] } }]
      : [{ metadata: { name: 'network' }, status: { conditions: [{ type: 'Available', status: 'True' }, { type: 'Degraded', status: 'True' }] } }] }) }) });
    expect(await degraded.health({ profileId: profile.id, versionId: id })).toMatchObject({ querySucceeded: true, ready: false, operators: { degraded: 1 } });
    let queried = false;
    const changed = service({ getProfile: async () => ({ ...profile, revision: 'b'.repeat(64) }), lookup: async () => { queried = true; } });
    await expect(changed.probes({ profileId: profile.id, versionId: id })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(queried).toBe(false);
  });

  it('handles asynchronous monitor spawn errors without orphaned active state', async () => {
    const proc = child(); const svc = service({ spawnProcess: () => proc });
    await svc.startMonitor({ profileId: profile.id, versionId: id }); queueMicrotask(() => proc.emit('error', new Error('spawn')));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(svc.isMonitorActive()).toBe(false); expect((await svc.monitorStatus()).state).toBe('failed');
  });

  it('rejects symlink monitor and audit logs', async () => {
    const logRoot = path.join(root, 'logs', 'okd'); fs.mkdirSync(logRoot, { recursive: true }); const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'private');
    fs.symlinkSync(outside, path.join(logRoot, 'monitor.log'));
    await expect(service().startMonitor({ profileId: profile.id, versionId: id })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    fs.unlinkSync(path.join(logRoot, 'monitor.log')); fs.symlinkSync(outside, path.join(logRoot, 'audit.jsonl'));
    await expect(service().audit('profile.save', 'succeeded', { profileId: profile.id })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
});

describe('OKD probes, retention, diagnostics, and audit', () => {
  it('protects successful inactive/ISO workspaces and auth regardless of generation age', async () => {
    const workspace = writeWorkspace(); fs.mkdirSync(path.join(workspace, 'auth')); fs.writeFileSync(path.join(workspace, 'auth', 'kubeconfig'), 'dummy');
    expect((await service().storageReport()).retention).toMatchObject({ count: 0, protectedInstallations: 1 });
    expect(await service().cleanup({ confirmed: true })).toMatchObject({ workspacesDeleted: 0 });
    expect(fs.existsSync(path.join(workspace, 'auth', 'kubeconfig'))).toBe(true);
  });
  it('derives a fixed probe set, rejects SSRF-shaped input, and sanitizes timeout errors', async () => {
    const sockets = [];
    const lookups = [];
    const svc = service({ probeTimeoutMs: 5, lookup: async (host) => { lookups.push(host); if (host.startsWith('api-int')) await new Promise(() => {}); return [{ address: host === 'pxe.example.com' ? '2001:db8::1' : '192.0.2.10' }]; }, connect: ({ host, port }) => {
      const socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; }; sockets.push({ host, port, socket }); setImmediate(() => socket.emit('connect')); return socket;
    } });
    await expect(svc.probes({ profileId: profile.id, host: '169.254.169.254' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const result = await svc.probes({ profileId: profile.id, versionId: id });
    expect(result.results.map((item) => item.hostname).sort()).toEqual(['api-int.lab.example.com', 'api.lab.example.com', 'api.lab.example.com', 'api-int.lab.example.com', 'console-openshift-console.apps.lab.example.com', 'console-openshift-console.apps.lab.example.com', 'pxe.example.com', 'pxe.example.com'].sort());
    expect(result.results.find((item) => item.hostname.startsWith('api-int') && item.probe === 'dns')).toMatchObject({ success: false, error: 'timeout' });
    expect(lookups.sort()).toEqual(['api-int.lab.example.com', 'api.lab.example.com', 'console-openshift-console.apps.lab.example.com', 'pxe.example.com'].sort());
    expect(sockets.map(({ host, port }) => `${host}:${port}`)).toEqual(['192.0.2.10:6443', '192.0.2.10:443', '2001:db8::1:443']);
    expect(sockets.every(({ host }) => !host.includes('example.com'))).toBe(true);
  });

  it('reports aggregates, preserves records/public artifacts, blocks active work, and rejects symlink cleanup', async () => {
    writeJob('failed');
    const jobFile = path.join(root, 'config', 'okd', 'jobs', `${id}.json`);
    const job = JSON.parse(fs.readFileSync(jobFile)); job.versionId = null; fs.writeFileSync(jobFile, JSON.stringify(job));
    const workspace = writeWorkspace(); fs.writeFileSync(path.join(workspace, 'state'), 'private');
    const log = path.join(root, 'logs', 'okd'); fs.mkdirSync(log, { recursive: true }); fs.writeFileSync(path.join(log, `${id}.log`), 'safe');
    const artifact = path.join(root, 'assets', 'okd', profile.id, id); fs.mkdirSync(artifact, { recursive: true }); fs.writeFileSync(path.join(artifact, 'manifest.json'), '{}');
    const report = await service().storageReport(); expect(report.retention).toMatchObject({ enabled: true, count: 0, protectedInstallations: 1 }); expect(JSON.stringify(report)).not.toContain(root);
    expect(await service().cleanup({ confirmed: true })).toMatchObject({ workspacesDeleted: 0, logsDeleted: 0 });
    expect(fs.existsSync(workspace)).toBe(true); expect(fs.existsSync(artifact)).toBe(true);
    fs.rmSync(artifact, { recursive: true }); // explicit media retirement in this disposable fixture only
    await expect(service({ isGenerationActive: () => true }).cleanup({ confirmed: true })).rejects.toMatchObject({ code: 'OPERATION_ACTIVE' });
    fs.symlinkSync(path.join(root, 'outside'), path.join(workspace, 'unsafe'));
    await expect(service().cleanup({ confirmed: true })).rejects.toMatchObject({ code: 'UNSAFE_PATH' }); fs.unlinkSync(path.join(workspace, 'unsafe'));
    const cleaned = await service().cleanup({ confirmed: true }); expect(cleaned).toEqual({ jobsPreserved: 1, workspacesDeleted: 1, logsDeleted: 1 });
    expect(fs.existsSync(path.join(root, 'config', 'okd', 'jobs', `${id}.json`))).toBe(true);
  });

  it('protects finalized media and auth after terminal persistence failure clears versionId', async () => {
    writeJob('failed'); const jobFile = path.join(root, 'config', 'okd', 'jobs', `${id}.json`);
    const job = JSON.parse(fs.readFileSync(jobFile)); job.versionId = null; job.errorCode = 'PERSISTENCE_FAILED'; fs.writeFileSync(jobFile, JSON.stringify(job));
    const workspace = writeWorkspace(); fs.mkdirSync(path.join(workspace, 'auth')); fs.writeFileSync(path.join(workspace, 'auth', 'kubeconfig'), 'dummy');
    fs.mkdirSync(path.join(root, 'assets', 'okd', profile.id, id), { recursive: true });
    expect((await service().storageReport()).retention).toMatchObject({ count: 0, protectedInstallations: 1 });
    expect(await service().cleanup({ confirmed: true })).toMatchObject({ workspacesDeleted: 0 });
    expect(fs.existsSync(path.join(workspace, 'auth', 'kubeconfig'))).toBe(true);
  });

  it.each(['127.0.0.1', '127.254.1.2', '169.254.169.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.1.2.3', '240.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'febf::1', 'ff00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe', '::ffff:0:0', '::ffff:e000:1'])('blocks unsafe DNS destination %s before connecting', async (address) => {
    let connections = 0;
    const svc = service({ lookup: async () => [{ address }], connect: () => { connections += 1; throw new Error('must not connect'); } });
    const result = await svc.probes({ profileId: profile.id, versionId: id });
    expect(connections).toBe(0);
    expect(result.results.every((item) => !item.success && item.error === 'address_blocked')).toBe(true);
  });

  it.each(['10.1.2.3', '172.16.0.1', '192.168.7.10', 'fd00::10', 'fc00::1', '::ffff:c0a8:70a'])('retains legitimate cluster destination %s', async (address) => {
    const connected = [];
    const svc = service({ lookup: async () => [{ address }], connect: ({ host }) => {
      connected.push(host); const socket = new EventEmitter(); socket.destroy = () => {}; setImmediate(() => socket.emit('connect')); return socket;
    } });
    expect((await svc.probes({ profileId: profile.id, versionId: id })).results.every((item) => item.success)).toBe(true);
    expect(connected).toEqual(Array(4).fill(address));
  });

  it('fails mixed safe/unsafe DNS answers closed without a second lookup or connection', async () => {
    let lookups = 0; let connections = 0;
    const svc = service({ lookup: async () => { lookups += 1; return [{ address: '192.168.7.10' }, { address: '::ffff:7f00:1' }]; }, connect: () => { connections += 1; } });
    const result = await svc.probes({ profileId: profile.id, versionId: id });
    expect(lookups).toBe(4); expect(connections).toBe(0);
    expect(result.results.every((item) => item.error === 'address_blocked')).toBe(true);
  });

  it('guards active publication candidates and returns safe diagnostics', async () => {
    const publications = path.join(root, 'config', 'okd', 'publications'); fs.mkdirSync(publications, { recursive: true }); fs.writeFileSync(path.join(publications, `${profile.id}.json`), JSON.stringify({ versionId: id }));
    const svc = service(); const report = await svc.storageReport(); expect(report.retention).toMatchObject({ count: 0, blockedByPublication: 1 });
    const result = await svc.diagnostics(); expect(result).toMatchObject({ configured: { persistence: true, publicBaseUrl: true }, tools: { installer: true, oc: true }, inventory: { profiles: 1, publications: 1 }, romManifestReady: true });
    expect(JSON.stringify(result)).not.toMatch(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('ignores forged retention records whose filename, id, log, or schema disagree', async () => {
    const jobs = path.join(root, 'config', 'okd', 'jobs');
    fs.writeFileSync(path.join(jobs, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), JSON.stringify({ id, profileId: profile.id, state: 'failed', finishedAt: '2020-01-01T00:00:00Z', log: `${id}.log` }));
    writeJob('failed'); const valid = JSON.parse(fs.readFileSync(path.join(jobs, `${id}.json`))); valid.log = 'other.log'; valid.untrusted = true; fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify(valid));
    expect((await service().storageReport()).retention.count).toBe(0);
  });

  it('writes only allowlisted mode-0600 audit fields and rotates once', async () => {
    const svc = service({ auditMaxBytes: 100 });
    await svc.audit('profile.save', 'succeeded', { profileId: profile.id, secret: 'never-write-me' });
    await svc.audit('unknown.action', 'succeeded', { profileId: profile.id });
    await svc.audit('generation.start', 'accepted', { profileId: profile.id, jobId: id, mode: 'pxe', path: root });
    const audit = path.join(root, 'logs', 'okd', 'audit.jsonl'); const combined = [audit, `${audit}.1`].filter(fs.existsSync).map((file) => fs.readFileSync(file, 'utf8')).join('');
    expect(combined).toContain('profile.save'); expect(combined).toContain('generation.start'); expect(combined).not.toMatch(/never-write-me|unknown.action|"path"/); expect(fs.statSync(audit).mode & 0o777).toBe(0o600); expect(fs.existsSync(`${audit}.1`)).toBe(true);
  });

  it('refuses a symlinked rotated audit target', async () => {
    const svc = service({ auditMaxBytes: 1 }); await svc.audit('profile.save', 'succeeded', { profileId: profile.id });
    const audit = path.join(root, 'logs', 'okd', 'audit.jsonl'); const outside = path.join(root, 'outside-audit'); fs.writeFileSync(outside, 'private'); fs.symlinkSync(outside, `${audit}.1`);
    await expect(svc.audit('profile.delete', 'succeeded', { profileId: profile.id })).rejects.toMatchObject({ code: 'UNSAFE_PATH' }); expect(fs.readFileSync(outside, 'utf8')).toBe('private');
  });
});
