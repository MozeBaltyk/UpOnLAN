import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { spawn as realSpawn } from 'child_process';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const { createJobService, renderConfigs, makeRedactor } = require('../../services/okdJobServices.js');
const { COMPATIBILITY_RECORD } = require('../../services/okdServices.js');
const { createProfileJobCoordinator } = require('../../sockets/okdHandlers.js');
const { createPullSecretService } = require('../../services/okdPullSecretServices.js');
let root;

const baseProfile = {
  id: 'lab-okd', revision: 'a'.repeat(64), release: COMPATIBILITY_RECORD.release,
  platform: 'none', topology: 'sno', cluster_name: 'lab', base_domain: 'example.com',
  machine_network: '192.168.7.0/24', rendezvous_ip: '192.168.7.10',
  ssh_public_key: 'ssh-ed25519 AAAATest', worker_count: 0, api_vip: '', ingress_vip: '',
  hosts: [{ hostname: 'master-0', role: 'control-plane', mac: '02:00:00:00:00:10', ipv4: '192.168.7.10', interface: 'eno1', disk_hint: 'serial:disk-1' }],
};
const metadata = { archiveSha256: 'b'.repeat(64), binarySha256: 'c'.repeat(64) };

function child(pid = 4321) {
  const proc = new EventEmitter();
  proc.pid = pid; proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  return proc;
}

function service(overrides = {}) {
  const secret = path.join(root, 'pull-secret');
  if (!fs.existsSync(secret)) fs.writeFileSync(secret, '{"auths":{"quay.io":{"auth":"dXNlcjpwYXNz"}}}', { mode: 0o400 });
  return createJobService({
    configRoot: path.join(root, 'config'), logsRoot: path.join(root, 'logs'), pullSecretFile: secret,
    publicBaseUrl: 'https://pxe.example.com/', persistenceReady: true,
    getProfile: async () => baseProfile,
    getTemplates: async () => ({ ...renderConfigs(baseProfile), revision: baseProfile.revision }),
    getVerifiedInstaller: async () => ({ path: '/verified/cache/openshift-install', metadata }),
    getVerifiedOc: async () => ({ path: '/verified/oc-cache/oc', metadata }),
    finalizeArtifacts: async ({ job: record }) => ({ versionId: record.id }),
    jobId: () => '12345678-1234-1234-1234-123456789abc',
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'okd-jobs-'));
  process.env.WEBAPP_USER = 'operator'; process.env.WEBAPP_PASS = 'secret'; process.env.UNRELATED_SECRET = 'private';
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.WEBAPP_USER; delete process.env.WEBAPP_PASS; delete process.env.UNRELATED_SECRET; });

describe('OKD generation schema', () => {
  it('renders exact none SNO schema and maps control-plane to master', () => {
    const rendered = renderConfigs(baseProfile, '{"auths":{}}');
    expect(yaml.load(rendered.installConfig)).toEqual({
      apiVersion: 'v1', baseDomain: 'example.com', metadata: { name: 'lab' },
      compute: [{ architecture: 'amd64', hyperthreading: 'Enabled', name: 'worker', replicas: 0 }],
      controlPlane: { architecture: 'amd64', hyperthreading: 'Enabled', name: 'master', replicas: 1 },
      networking: { machineNetwork: [{ cidr: '192.168.7.0/24' }], networkType: 'OVNKubernetes' },
      platform: { none: {} }, publish: 'External', pullSecret: '{"auths":{}}', sshKey: 'ssh-ed25519 AAAATest',
    });
    expect(yaml.load(rendered.agentConfig)).toEqual({
      apiVersion: 'v1alpha1', kind: 'AgentConfig', metadata: { name: 'lab' }, rendezvousIP: '192.168.7.10',
      hosts: [{ hostname: 'master-0', role: 'master', interfaces: [{ name: 'eno1', macAddress: '02:00:00:00:00:10' }], rootDeviceHints: { serialNumber: 'disk-1' } }],
    });
  });

  it('renders baremetal VIP lists and compact/standard replica counts', () => {
    const baremetal = { ...baseProfile, platform: 'baremetal', topology: 'compact', api_vip: '192.168.7.20', ingress_vip: '192.168.7.21', hosts: Array.from({ length: 3 }, (_, i) => ({ ...baseProfile.hosts[0], hostname: `master-${i}`, mac: `02:00:00:00:00:1${i}` })) };
    expect(yaml.load(renderConfigs(baremetal, '{}').installConfig)).toMatchObject({ controlPlane: { replicas: 3 }, platform: { baremetal: { apiVIPs: ['192.168.7.20'], ingressVIPs: ['192.168.7.21'] } } });
    const standard = { ...baremetal, topology: 'standard', worker_count: 1, hosts: [...baremetal.hosts, { ...baseProfile.hosts[0], hostname: 'worker-0', role: 'worker', disk_hint: 'deviceName:/dev/vda' }] };
    const configs = renderConfigs(standard, '{}');
    expect(yaml.load(configs.installConfig).compute[0].replicas).toBe(1);
    expect(yaml.load(configs.agentConfig).hosts.at(-1)).toMatchObject({ role: 'worker', rootDeviceHints: { deviceName: '/dev/vda' } });
  });
});

describe('OKD generation jobs', () => {
  it.each(['pxe', 'iso'])('uses the public default only in the private %s generation workspace without web auth', async (mode) => {
    delete process.env.WEBAPP_USER; delete process.env.WEBAPP_PASS;
    const proc = child(); let workspace;
    const secretService = createPullSecretService({ configRoot: path.join(root, 'config'), externalFile: path.join(root, 'absent-mount'), externalConfigured: false });
    const svc = service({ pullSecretService: secretService, spawnProcess: (_command, _args, options) => { workspace = options.cwd; return proc; } });
    expect(await svc.preflight('lab-okd', baseProfile.revision)).toMatchObject({ ready: true });
    const record = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true, mode });
    expect(yaml.load(fs.readFileSync(path.join(workspace, 'install-config.yaml'), 'utf8')).pullSecret).toBe('{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}');
    expect(fs.statSync(path.join(workspace, 'install-config.yaml')).mode & 0o777).toBe(0o600);
    expect(yaml.load(renderConfigs(baseProfile).installConfig).pullSecret).toBe('{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}');
    expect(fs.existsSync(path.join(root, 'config/okd/secrets/pull-secret'))).toBe(false);
    expect(JSON.stringify(record)).not.toMatch(/aWQ6|"auths"/);
    proc.stdout.write('aWQ6cGFzcwo='); proc.emit('close', 1, null);
    while (svc.isActive()) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await svc.readLog(record.id)).text).not.toContain('aWQ6cGFzcwo=');
  });
  it('requires the verified client and prepends only its directory to installer PATH', async () => {
    const missing = service({ getVerifiedOc: async () => { throw Object.assign(new Error('Client not prepared.'), { code: 'OC_NOT_READY' }); } });
    expect(await missing.preflight('lab-okd', baseProfile.revision)).toMatchObject({ ready: false, errors: [{ field: 'oc' }] });
    await expect(missing.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true })).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' });
    const proc = child(); let env;
    const svc = service({ spawnProcess: (_command, _args, options) => { env = options.env; return proc; } });
    await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    expect(env.PATH).toBe(`/verified/oc-cache${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`);
    expect(env.WEBAPP_PASS).toBeUndefined(); expect(env.UNRELATED_SECRET).toBeUndefined();
    proc.emit('close', 1, null);
    while (svc.isActive()) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  it('serializes profile start/delete orchestration and rejects deletion once start is active', async () => {
    let active = false;
    const coordinator = createProfileJobCoordinator({
      startJob: async () => { active = true; return { id: 'job' }; },
      isProfileActive: () => active,
      deleteProfile: async (_id, predicate) => {
        if (predicate()) throw Object.assign(new Error('active'), { code: 'PROFILE_ACTIVE' });
        return { id: 'lab-okd' };
      },
    });
    const started = coordinator.start({ profileId: 'lab-okd' });
    const deleted = coordinator.delete('lab-okd');
    await expect(started).resolves.toEqual({ id: 'job' });
    await expect(deleted).rejects.toMatchObject({ code: 'PROFILE_ACTIVE' });
  });

  it('serializes simultaneous generation/monitor starts and enforces lifetime exclusion', async () => {
    let generation = false; let monitoring = false;
    const coordinator = createProfileJobCoordinator({
      startJob: async () => { generation = true; return { id: 'job' }; },
      startMonitor: async () => { monitoring = true; return { state: 'running' }; },
      isGenerationActive: () => generation, isMonitorActive: () => monitoring,
      isProfileActive: () => false, deleteProfile: async () => ({}),
    });
    const [started, blocked] = await Promise.allSettled([coordinator.start({}), coordinator.monitor({})]);
    expect(started.status).toBe('fulfilled'); expect(blocked).toMatchObject({ status: 'rejected', reason: { code: 'OPERATION_ACTIVE' } });
    generation = false;
    await expect(coordinator.monitor({})).resolves.toMatchObject({ state: 'running' });
    await expect(coordinator.start({})).rejects.toMatchObject({ code: 'OPERATION_ACTIVE' });
  });

  it('fails preflight for unreadable/malformed pull secrets and unverified installer without exposing values', async () => {
    const secret = path.join(root, 'pull-secret');
    fs.writeFileSync(secret, 'not-json');
    let result = await service({ pullSecretFile: secret }).preflight('lab-okd', baseProfile.revision);
    expect(result).toMatchObject({ ready: false, errors: [{ field: 'pull_secret' }] });
    expect(JSON.stringify(result)).not.toContain('not-json');
    fs.writeFileSync(secret, '{"auths":{"quay.io":{}}}');
    result = await service({ pullSecretFile: secret }).preflight('lab-okd', baseProfile.revision);
    expect(result.errors.map((e) => e.field)).toContain('pull_secret');
    fs.rmSync(secret); fs.mkdirSync(secret);
    result = await service({ pullSecretFile: secret, getVerifiedInstaller: async () => { throw Object.assign(new Error('The exact installer is not verified.'), { code: 'INSTALLER_NOT_READY' }); } }).preflight('lab-okd', baseProfile.revision);
    expect(result.errors.map((e) => e.field).sort()).toEqual(['installer', 'pull_secret']);
  });

  it('requires an exact lowercase SHA-256 profile revision on every preflight', async () => {
    for (const revision of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}x`]) {
      const check = await service().preflight('lab-okd', revision);
      expect(check.errors.map((error) => error.field)).toContain('revision');
    }
    expect((await service().preflight('lab-okd', baseProfile.revision)).errors.map((error) => error.field)).not.toContain('revision');
  });

  it('does not require optional global web authentication for generation readiness', async () => {
    delete process.env.WEBAPP_USER; delete process.env.WEBAPP_PASS;
    const check = await service().preflight('lab-okd', baseProfile.revision);
    expect(check.ready).toBe(true); expect(check.errors.map((error) => error.field)).not.toContain('authentication');
  });

  it('rechecks the requested revision after preflight before creating a workspace job', async () => {
    let reads = 0; let spawned = false;
    const svc = service({
      getProfile: async () => ({ ...baseProfile, revision: reads++ === 0 ? baseProfile.revision : 'd'.repeat(64) }),
      spawnProcess: () => { spawned = true; return child(); },
    });
    await expect(svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true })).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' });
    expect(spawned).toBe(false);
  });

  it('rejects symlinked storage roots and pull-secret files', async () => {
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, 'config'));
    fs.symlinkSync(outside, path.join(root, 'config', 'okd'));
    await expect(service().initialize()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    fs.rmSync(path.join(root, 'config', 'okd'));
    const target = path.join(root, 'real-secret');
    fs.writeFileSync(target, '{"auths":{"quay.io":{"auth":"abc"}}}');
    const link = path.join(root, 'secret-link'); fs.symlinkSync(target, link);
    const check = await service({ pullSecretFile: link }).preflight('lab-okd', baseProfile.revision);
    expect(check.errors.map((error) => error.field)).toContain('pull_secret');
  });

  it('uses only the verified absolute installer, finalizes PXE success, and excludes a second job', async () => {
    const proc = child(); let invocation;
    const svc = service({ spawnProcess: (...args) => { invocation = args; return proc; } });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    expect(invocation.slice(0, 2)).toEqual(['/verified/cache/openshift-install', ['agent', 'create', 'pxe-files', '--dir', expect.stringContaining('/config/okd/workspaces/lab-okd/')]]);
    expect(invocation[2]).toMatchObject({ detached: true, shell: false });
    expect(invocation[2].env).not.toHaveProperty('WEBAPP_USER'); expect(invocation[2].env).not.toHaveProperty('WEBAPP_PASS'); expect(invocation[2].env).not.toHaveProperty('UNRELATED_SECRET');
    await expect(svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true })).rejects.toMatchObject({ code: 'JOB_ACTIVE' });
    proc.stdout.write('safe output\n'); proc.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const record = (await svc.status()).history[0];
    expect(record).toMatchObject({ id: started.id, state: 'succeeded', mode: 'pxe', versionId: started.id, profileRevision: baseProfile.revision, installerBinarySha256: metadata.binarySha256 });
    const diskRecord = fs.readFileSync(path.join(root, 'config/okd/jobs', `${started.id}.json`), 'utf8');
    expect(diskRecord).not.toContain('workspaces');
    expect(diskRecord).not.toContain('dXNlcjpwYXNz');
    expect(fs.statSync(path.join(root, 'config/okd/workspaces/lab-okd', started.id)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'config/okd/workspaces/lab-okd', started.id, 'install-config.yaml')).mode & 0o777).toBe(0o600);
  });

  it('removes secret-bearing setup state when config, log, record, or synchronous spawn setup fails', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    const realWrite = fs.promises.writeFile.bind(fs.promises);
    const failures = [
      { writeJobFile: async (file, ...args) => { if (file.endsWith('agent-config.yaml')) throw new Error('config'); return realWrite(file, ...args); } },
      { writeJobFile: async (file, ...args) => { if (file.endsWith('.log')) throw new Error('log'); return realWrite(file, ...args); } },
      { renameRecord: async () => { throw new Error('record'); } },
      { spawnProcess: () => { throw new Error('spawn'); }, code: 'SPAWN_FAILED' },
    ];
    for (const failure of failures) {
      const svc = service(failure);
      const started = svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
      if (failure.code) await expect(started).rejects.toMatchObject({ code: failure.code }); else await expect(started).rejects.toThrow();
      expect(fs.existsSync(path.join(root, 'config/okd/workspaces/lab-okd', id))).toBe(false);
      expect(fs.existsSync(path.join(root, 'logs/okd', `${id}.log`))).toBe(false);
      expect(fs.existsSync(path.join(root, 'config/okd/jobs', `${id}.json`))).toBe(false);
    }
  });

  it.each(['public', 'legacy sentinel'])('consumes edited %s templates and injects the pull secret only into the private workspace copy', async (format) => {
    const proc = child();
    const edited = renderConfigs(baseProfile);
    const install = yaml.load(edited.installConfig); install.additionalTrustBundle = 'supplemental-test-ca';
    if (format === 'legacy sentinel') install.pullSecret = '__UPONLAN_PULL_SECRET__';
    const agent = yaml.load(edited.agentConfig); agent.hosts[0].networkConfig = { interfaces: [] };
    const svc = service({
      getTemplates: async () => ({ installConfig: yaml.dump(install), agentConfig: yaml.dump(agent), revision: baseProfile.revision }),
      spawnProcess: () => proc,
    });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    const workspace = path.join(root, 'config/okd/workspaces/lab-okd', started.id);
    expect(yaml.load(fs.readFileSync(path.join(workspace, 'install-config.yaml'), 'utf8'))).toMatchObject({ additionalTrustBundle: 'supplemental-test-ca', pullSecret: '{"auths":{"quay.io":{"auth":"dXNlcjpwYXNz"}}}' });
    const privateAgent = yaml.load(fs.readFileSync(path.join(workspace, 'agent-config.yaml'), 'utf8'));
    expect(privateAgent.hosts[0].networkConfig).toEqual({ interfaces: [] });
    expect(privateAgent.bootArtifactsBaseURL).toBe(`https://pxe.example.com/okd/lab-okd/${started.id}`);
    expect(agent.bootArtifactsBaseURL).toBeUndefined();
    expect(install.pullSecret).toBe(format === 'legacy sentinel' ? '__UPONLAN_PULL_SECRET__' : '{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}');
    expect(JSON.stringify(await svc.status())).not.toContain('dXNlcjpwYXNz');
    expect(started.context).toEqual({ clusterName: 'lab', baseDomain: 'example.com', topology: 'sno', hosts: [{ hostname: 'master-0', role: 'master', rootDeviceHints: { serialNumber: 'disk-1' } }] });
    proc.emit('close', 7, null);
  });

  it('uses a valid internal pull secret when the default external mount is absent', async () => {
    const internal = path.join(root, 'config/okd/secrets/pull-secret');
    fs.mkdirSync(path.dirname(internal), { recursive: true }); fs.writeFileSync(internal, '{"auths":{"internal.example":{"auth":"internal-private-value"}}}', { mode: 0o600 });
    const proc = child();
    const svc = service({ pullSecretFile: '/run/secrets/okd-pull-secret', spawnProcess: () => proc });
    expect((await svc.preflight('lab-okd', baseProfile.revision)).ready).toBe(true);
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    const workspace = path.join(root, 'config/okd/workspaces/lab-okd', started.id);
    expect(yaml.load(fs.readFileSync(path.join(workspace, 'install-config.yaml'), 'utf8')).pullSecret).toContain('internal-private-value');
    expect((await svc.status()).history[0]).not.toHaveProperty('pullSecret');
    proc.emit('close', 7, null);
  });

  it('runs the explicit ISO command and finalizes it with the selected mode', async () => {
    const proc = child(); let invocation; let finalized;
    const svc = service({
      spawnProcess: (...args) => { invocation = args; return proc; },
      finalizeArtifacts: async (request) => { finalized = request; return { versionId: request.job.id }; },
    });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true, mode: 'iso' });
    expect(invocation[1]).toEqual(['agent', 'create', 'image', '--dir', expect.stringContaining('/config/okd/workspaces/lab-okd/')]);
    proc.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finalized).toMatchObject({ profile: baseProfile, mode: 'iso', job: { id: started.id, mode: 'iso' } });
    expect((await svc.status()).history[0]).toMatchObject({ state: 'succeeded', mode: 'iso', versionId: started.id });
  });

  it('marks installer exit zero failed when safe artifact finalization fails', async () => {
    const proc = child();
    const svc = service({ spawnProcess: () => proc, finalizeArtifacts: async () => { throw new Error('/private/workspace detail'); } });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true, mode: 'pxe' });
    proc.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const record = (await svc.status()).history[0];
    expect(record).toMatchObject({ state: 'failed', mode: 'pxe', versionId: null, errorCode: 'ARTIFACT_FINALIZATION_FAILED', message: 'Installer artifacts could not be finalized safely.' });
    expect(JSON.stringify(record)).not.toContain('/private/workspace');
    expect(fs.readFileSync(path.join(root, 'config/okd/jobs', `${started.id}.json`), 'utf8')).not.toContain('/private/workspace');
  });

  it('keeps the one-job guard during finalization without signalling a closed installer', async () => {
    const proc = child(); let finishFinalization;
    const svc = service({
      spawnProcess: () => proc,
      finalizeArtifacts: ({ job: record }) => new Promise((resolve) => { finishFinalization = () => resolve({ versionId: record.id }); }),
    });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    proc.emit('close', 0, null);
    for (let attempt = 0; attempt < 20 && (await svc.status()).current.state !== 'finalizing'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect((await svc.status()).current.state).toBe('finalizing');
    await expect(svc.cancel(started.id)).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
    await expect(svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true })).rejects.toMatchObject({ code: 'JOB_ACTIVE' });
    finishFinalization();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await svc.status()).history[0].state).toBe('succeeded');
  });

  it('persists failure and redacts secrets across chunks while bounding browser log reads', async () => {
    const proc = child();
    const svc = service({ spawnProcess: () => proc });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    const workspace = path.join(root, 'config/okd/workspaces/lab-okd', started.id);
    proc.stderr.write('auth=dXNlcj'); proc.stderr.write('pwYXNz\npassword=hunter2\n');
    proc.stderr.write(`workspace=${workspace}\nclient-key-data: private-key\n`);
    proc.stdout.write('x'.repeat(300000) + '\n'); proc.emit('close', 7, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await svc.status()).history[0].state).toBe('failed');
    const log = await svc.readLog(started.id, 999999);
    expect(Buffer.byteLength(log.text)).toBeLessThanOrEqual(64 * 1024);
    expect(log.truncated).toBe(true);
    const stored = fs.readFileSync(path.join(root, 'logs/okd', `${started.id}.log`), 'utf8');
    expect(stored).not.toContain('dXNlcjpwYXNz'); expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain(workspace); expect(stored).not.toContain('private-key');
  });

  it('handles a real asynchronous spawn error without an unhandled error event', async () => {
    const svc = service({
      spawnProcess: realSpawn,
      getVerifiedInstaller: async () => ({ path: path.join(root, 'does-not-exist', 'openshift-install'), metadata }),
    });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    for (let attempt = 0; attempt < 50 && (await svc.status()).history[0].state === 'running'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await svc.status()).history[0]).toMatchObject({ id: started.id, state: 'failed' });
  });

  it('terminates the child and clears active state after asynchronous startup persistence failure', async () => {
    const proc = child(); const signals = []; let renames = 0;
    const svc = service({ renameRecord: async (from, to) => {
      renames += 1; await Promise.resolve(); if (renames === 2) throw new Error('persist'); await fs.promises.rename(from, to);
    }, spawnProcess: () => proc, cancelTimeoutMs: 5, killGroup: (_pid, signal) => { signals.push(signal); if (signal === 'SIGTERM') queueMicrotask(() => proc.emit('close', null, signal)); } });
    await expect(svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(signals[0]).toBe('SIGTERM'); expect(svc.isActive()).toBe(false); expect((await svc.status()).history[0]).toMatchObject({ state: 'failed', errorCode: 'PERSISTENCE_FAILED' });
  });

  it('turns a terminal persistence failure into a sanitized durable failure', async () => {
    const proc = child(); let renames = 0;
    const svc = service({
      spawnProcess: () => proc,
      renameRecord: async (from, to) => {
        renames += 1;
        if (renames === 4) throw new Error('/private/persistence detail');
        await fs.promises.rename(from, to);
      },
    });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    proc.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const record = (await svc.status()).history[0];
    expect(record).toMatchObject({ id: started.id, state: 'failed', errorCode: 'PERSISTENCE_FAILED', message: 'Job state could not be persisted safely.' });
    expect(JSON.stringify(record)).not.toContain('/private/persistence');
  });

  it('clears active state and reports an in-memory failure when terminal persistence cannot recover', async () => {
    const proc = child(); let renames = 0;
    const svc = service({
      spawnProcess: () => proc,
      renameRecord: async (from, to) => {
        renames += 1;
        if (renames >= 4) throw new Error('persistent failure');
        await fs.promises.rename(from, to);
      },
    });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    proc.emit('close', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await svc.status()).current).toBeNull();
    expect((await svc.status()).history[0]).toMatchObject({ id: started.id, state: 'persistence_failed', errorCode: 'PERSISTENCE_FAILED' });
    expect(svc.isProfileActive('lab-okd')).toBe(false); expect(svc.isActive()).toBe(false);
  });

  it('reports another profile active job as a global blocker, not the selected current job', async () => {
    const proc = child();
    const svc = service({ spawnProcess: () => proc });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    expect(await svc.status('other-profile')).toMatchObject({
      current: null, blocking: { id: started.id, profileId: 'lab-okd', state: 'running' }, history: [],
    });
    proc.emit('close', 7, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('sends TERM then KILL only to its in-memory process group', async () => {
    const proc = child(9876); const signals = [];
    const svc = service({ spawnProcess: () => proc, cancelTimeoutMs: 5, killGroup: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') queueMicrotask(() => proc.emit('close', null, signal)); } });
    const started = await svc.start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true });
    await svc.cancel(started.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toEqual([[9876, 'SIGTERM'], [9876, 'SIGKILL']]);
    expect((await svc.status()).history[0].state).toBe('cancelled');
    await expect(svc.cancel(started.id)).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
  });

  it('marks persisted active jobs interrupted on restart without signalling a PID', async () => {
    const jobs = path.join(root, 'config/okd/jobs'); fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, '12345678-1234-1234-1234-123456789abc.json'), JSON.stringify({ id: '12345678-1234-1234-1234-123456789abc', profileId: 'lab-okd', state: 'running', createdAt: '2026-01-01T00:00:00Z' }));
    let signalled = false;
    const svc = service({ killGroup: () => { signalled = true; } });
    await svc.initialize();
    expect((await svc.status()).history[0].state).toBe('interrupted');
    expect(signalled).toBe(false);
  });

  it('refuses symlinked logs instead of exposing private files', async () => {
    const svc = service(); await svc.initialize();
    const id = '12345678-1234-1234-1234-123456789abc';
    const privateFile = path.join(root, 'private-kubeconfig'); fs.writeFileSync(privateFile, 'kubeconfig-secret');
    fs.symlinkSync(privateFile, path.join(root, 'logs/okd', `${id}.log`));
    await expect(svc.readLog(id)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:ELOOP|UNSAFE_PATH)$/) });
  });

  it('requires confirmation, unchanged revision, trusted settings, and persistence', async () => {
    await expect(service().start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const check = await service({ publicBaseUrl: 'http://pxe.example.com/', persistenceReady: false }).preflight('lab-okd', 'stale');
    expect(check.errors.map((e) => e.field).sort()).toEqual(['persistence', 'public_base_url', 'revision']);
    await expect(service().start({ profileId: 'lab-okd', revision: baseProfile.revision, confirmed: true, mode: 'tarball' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('stream redaction', () => {
  it('redacts exact secret values and obvious credential fields across chunks', () => {
    const redactor = makeRedactor('{"auths":{"x":{"auth":"abc123"}}}', { auths: { x: { auth: 'abc123', token: 'token-value' } } });
    const output = redactor.feed('auth=abc') + redactor.feed('123\ntoken=token-') + redactor.feed('value\n') + redactor.flush();
    expect(output).not.toContain('abc123'); expect(output).not.toContain('token-value');
    expect(output).toContain('[REDACTED]');
  });
});
