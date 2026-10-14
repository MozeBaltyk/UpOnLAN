import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { createFixtureRoot } from '../helpers/fixtures.js';

const require = createRequire(import.meta.url);
const { PUBLIC_PULL_SECRET } = require('../../services/okdPullSecretServices');
let okd;
let root;

function profile(overrides = {}) {
  return {
    id: 'lab-okd', release: '5.0.0-okd-scos.1', platform: 'none', topology: 'sno',
    cluster_name: 'lab', base_domain: 'example.com', machine_network: '192.168.7.0/24',
    rendezvous_ip: '192.168.7.10', ssh_public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey operator@example',
    worker_count: 0, api_vip: '', ingress_vip: '',
    hosts: [{ hostname: 'master-0', role: 'control-plane', mac: '02:00:00:00:00:10', ipv4: '192.168.7.10', interface: 'eno1', disk_hint: 'wwn:0x123' }],
    ...overrides,
  };
}

beforeEach(() => {
  root = createFixtureRoot();
  process.env.UPONLAN_CONFIG = path.join(root, 'config');
  process.env.UPONLAN_ASSETS = path.join(root, 'assets');
  delete require.cache[require.resolve('../../services/okdServices.js')];
  okd = require('../../services/okdServices.js');
});
afterEach(() => vi.restoreAllMocks());

describe('okdServices profile lifecycle and validation', () => {
  it('pins immutable Linux amd64 release and tool metadata', () => {
    expect(okd.COMPATIBILITY_RECORD).toMatchObject({
      revision: '5',
      release: '5.0.0-okd-scos.1',
      architecture: 'linux/amd64',
      schemas: { installConfigApiVersion: 'v1', agentConfigApiVersion: 'v1alpha1', agentConfigKind: 'AgentConfig', controlPlaneRole: 'master', baremetalVipFields: { api: 'apiVIPs', ingress: 'ingressVIPs' } },
      releaseImage: 'quay.io/okd/scos-release@sha256:a5e956045b37dc8c3d2fa78f43b33ae4da38dd99662c7b0deb81151f3359b612',
      outputs: {
        pxe: { kernel: 'agent.x86_64-vmlinuz', initrd: 'agent.x86_64-initrd.img', rootfs: 'agent.x86_64-rootfs.img', ipxe: 'agent.x86_64.ipxe' },
        iso: { iso: 'agent.x86_64.iso' },
      },
      tools: {
        installer: { archive: 'openshift-install-linux-5.0.0-okd-scos.1.tar.gz', archiveSha256: '2b1b15c4df45e77895a7e4c8f3e0f28d9e81cf2b34127a772f6159134e2bff24', required: true },
        oc: { archive: 'openshift-client-linux-5.0.0-okd-scos.1.tar.gz', archiveSha256: '49a71dc4b86c619bbf23e831c86d8e61be6d72b144669b00a819f6c0153e0f3e', required: true },
      },
    });
    expect(okd.COMPATIBILITY_RECORD.commands.monitor).toEqual(['agent', 'wait-for', 'install-complete', '--dir']);
    expect(okd.COMPATIBILITY_RECORD.tools.installer.sourceUrl).not.toContain('latest');
    expect(Object.isFrozen(okd.COMPATIBILITY_RECORD.tools.installer)).toBe(true);
  });

  it('atomically creates, lists, gets, revision-updates, and deletes sanitized YAML', async () => {
    const xssComment = `operator\"' <script>alert(1)</script>`;
    const saved = await okd.saveProfile(profile({ ssh_public_key: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey ${xssComment}` }));
    expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.saved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const dir = path.join(root, 'config', 'okd', 'profiles', 'lab-okd');
    expect(fs.readdirSync(dir).sort()).toEqual(['agent-config.yaml', 'install-config.yaml', 'profile.yml']);
    expect(fs.statSync(path.join(dir, 'install-config.yaml')).mode & 0o777).toBe(0o600);
    expect(yaml.load(fs.readFileSync(path.join(dir, 'install-config.yaml'), 'utf8')).pullSecret).toBe(PUBLIC_PULL_SECRET);
    expect(PUBLIC_PULL_SECRET).toBe('{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}');
    expect(yaml.load(fs.readFileSync(path.join(dir, 'profile.yml'), 'utf8'))).toEqual(saved);
    expect((await okd.listProfiles()).map((p) => p.id)).toEqual(['lab-okd']);
    expect((await okd.getProfile('lab-okd')).ssh_public_key).toContain(xssComment);
    await expect(okd.saveProfile(profile())).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });

    await expect(okd.saveProfile(profile({ cluster_name: 'changed' }), 'lab-okd', 'stale')).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const updated = await okd.saveProfile(profile({ cluster_name: 'changed' }), 'lab-okd', saved.revision);
    expect(updated.revision).not.toBe(saved.revision);
    expect((await okd.getProfile('lab-okd')).cluster_name).toBe('changed');
    expect(yaml.load((await okd.getTemplates('lab-okd')).installConfig).pullSecret).toBe(PUBLIC_PULL_SECRET);
    await expect(okd.saveProfile(profile({ id: 'other' }), 'lab-okd', updated.revision)).rejects.toMatchObject({ code: 'IMMUTABLE_ID' });
    await expect(okd.saveProfile(profile({ id: 'missing' }), 'missing', updated.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await okd.deleteProfile('lab-okd');
    expect(await okd.listProfiles()).toEqual([]);
  });

  it('serializes concurrent saves so the same expected revision cannot overwrite twice', async () => {
    const saved = await okd.saveProfile(profile());
    const results = await Promise.allSettled([
      okd.saveProfile(profile({ cluster_name: 'first' }), 'lab-okd', saved.revision),
      okd.saveProfile(profile({ cluster_name: 'second' }), 'lab-okd', saved.revision),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({ code: 'STALE_REVISION' });
    expect(['first', 'second']).toContain((await okd.getProfile('lab-okd')).cluster_name);
  });

  it('migrates a valid legacy profile-only fixture without blessing a tampered legacy revision', async () => {
    const legacy = profile();
    legacy.revision = crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
    legacy.saved_at = '2026-01-01T00:00:00.000Z';
    const dir = path.join(root, 'config/okd/profiles/lab-okd'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.yml'), yaml.dump(legacy), { mode: 0o600 });
    const listed = await okd.listProfiles();
    expect(listed).toHaveLength(1); expect(listed[0].revision).not.toBe(legacy.revision);
    expect(fs.readdirSync(dir).sort()).toEqual(['agent-config.yaml', 'install-config.yaml', 'profile.yml']);
    expect(yaml.load(fs.readFileSync(path.join(dir, 'install-config.yaml'), 'utf8')).pullSecret).toBe(PUBLIC_PULL_SECRET);

    const tampered = profile({ id: 'tampered', cluster_name: 'changed' });
    tampered.revision = crypto.createHash('sha256').update(JSON.stringify(profile({ id: 'tampered' }))).digest('hex');
    tampered.saved_at = legacy.saved_at;
    const tamperedDir = path.join(root, 'config/okd/profiles/tampered'); fs.mkdirSync(tamperedDir);
    fs.writeFileSync(path.join(tamperedDir, 'profile.yml'), yaml.dump(tampered), { mode: 0o600 });
    await expect(okd.getProfile('tampered')).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    expect(fs.readdirSync(tamperedDir)).toEqual(['profile.yml']);
  });

  it('rolls back an existing trio and removes a partial new profile after rename failure', async () => {
    const saved = await okd.saveProfile(profile());
    const dir = path.join(root, 'config/okd/profiles/lab-okd');
    const before = Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
    const rename = fs.promises.rename.bind(fs.promises); let calls = 0;
    let spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      calls += 1; if (calls === 4) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return rename(...args);
    });
    await expect(okd.saveProfile(profile({ cluster_name: 'changed' }), 'lab-okd', saved.revision)).rejects.toMatchObject({ code: 'EIO' });
    spy.mockRestore();
    expect(Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]))).toEqual(before);
    expect((await okd.getProfile('lab-okd')).revision).toBe(saved.revision);

    calls = 0; spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      calls += 1; if (calls === 1) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return rename(...args);
    });
    await expect(okd.saveProfile(profile({ id: 'new-profile' }))).rejects.toMatchObject({ code: 'EIO' });
    spy.mockRestore();
    expect(fs.existsSync(path.join(root, 'config/okd/profiles/new-profile'))).toBe(false);
  });

  it('reads and edits YAML with effective revision concurrency, then form save regenerates it', async () => {
    const saved = await okd.saveProfile(profile());
    const templates = await okd.getTemplates('lab-okd', saved.revision);
    const install = yaml.load(templates.installConfig); install.additionalTrustBundle = 'supplemental-test-ca';
    const edited = await okd.saveTemplates('lab-okd', saved.revision, yaml.dump(install), templates.agentConfig);
    expect(edited.revision).not.toBe(saved.revision);
    expect((await okd.getProfile('lab-okd')).revision).toBe(edited.revision);
    await expect(okd.saveTemplates('lab-okd', saved.revision, templates.installConfig, templates.agentConfig)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const regenerated = await okd.saveProfile(profile(), 'lab-okd', edited.revision);
    expect(yaml.load((await okd.getTemplates('lab-okd', regenerated.revision)).installConfig).additionalTrustBundle).toBeUndefined();
  });

  it('reads and edits old sentinel templates without normalizing bytes or revision, then regenerates on form Save', async () => {
    const saved = await okd.saveProfile(profile());
    const templates = await okd.getTemplates(saved.id);
    const installConfig = okd.renderConfigs(saved, okd.PULL_SECRET_PLACEHOLDER).installConfig;
    const old = await okd.saveTemplates(saved.id, saved.revision, installConfig, templates.agentConfig);
    expect((await okd.getProfile(saved.id)).revision).toBe(old.revision);
    expect(await okd.getTemplates(saved.id, old.revision)).toEqual({ installConfig, agentConfig: templates.agentConfig, revision: old.revision });
    expect(okd.effectiveContext(saved, old).clusterName).toBe('lab');
    const edited = await okd.saveTemplates(saved.id, old.revision, installConfig + '\n# legacy edit\n', templates.agentConfig);
    expect(yaml.load(edited.installConfig).pullSecret).toBe(okd.PULL_SECRET_PLACEHOLDER);
    const regenerated = await okd.saveProfile(profile(), saved.id, edited.revision);
    expect(yaml.load((await okd.getTemplates(saved.id, regenerated.revision)).installConfig).pullSecret).toBe(PUBLIC_PULL_SECRET);
  });

  it('rejects malformed, oversized, custom credentials, and symlinked templates', async () => {
    const saved = await okd.saveProfile(profile());
    const templates = await okd.getTemplates('lab-okd', saved.revision);
    await expect(okd.saveTemplates('lab-okd', saved.revision, ':[', templates.agentConfig)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    await expect(okd.saveTemplates('lab-okd', saved.revision, 'x'.repeat(256 * 1024 + 1), templates.agentConfig)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    const install = yaml.load(templates.installConfig); install.pullSecret = '{"auths":{"private":{"auth":"DUMMY-private-credential"}}}';
    const failure = await okd.saveTemplates('lab-okd', saved.revision, yaml.dump(install), templates.agentConfig).catch((err) => err);
    expect(failure).toMatchObject({ code: 'TEMPLATE_INVALID' });
    expect(failure.message).toContain('Pull Secret'); expect(failure.message).not.toContain('DUMMY-private-credential');
    const file = path.join(root, 'config/okd/profiles/lab-okd/install-config.yaml');
    fs.rmSync(file); fs.symlinkSync(path.join(root, 'outside-template'), file); fs.writeFileSync(path.join(root, 'outside-template'), templates.installConfig);
    await expect(okd.getTemplates('lab-okd')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects safety-critical YAML drift while retaining supplemental NMState/mirrors', async () => {
    const saved = await okd.saveProfile(profile()); const templates = await okd.getTemplates('lab-okd', saved.revision);
    for (const edit of [(i) => { i.metadata.name = 'other'; }, (i) => { i.baseDomain = 'other.example.com'; }, (i) => { i.controlPlane.replicas = 3; }, (i) => { i.controlPlane.architecture = 'arm64'; }, (i) => { i.networking.machineNetwork[0].cidr = '10.0.0.0/8'; }]) {
      const install = yaml.load(templates.installConfig); edit(install);
      await expect(okd.saveTemplates('lab-okd', saved.revision, yaml.dump(install), templates.agentConfig)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    }
    for (const edit of [(a) => { a.hosts[0].rootDeviceHints = { deviceName: '/dev/sdb' }; }, (a) => { a.hosts[0].role = 'worker'; }, (a) => { a.hosts[0].interfaces[0].name = 'eth9'; }, (a) => { a.cpuArchitecture = 'arm64'; }, (a) => { a.bootArtifactsBaseURL = 'https://other.example.com'; }]) {
      const agent = yaml.load(templates.agentConfig); edit(agent);
      await expect(okd.saveTemplates('lab-okd', saved.revision, templates.installConfig, yaml.dump(agent))).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    }
    const install = yaml.load(templates.installConfig); install.imageContentSources = [{ source: 'quay.io/example', mirrors: ['mirror.example.com/example'] }];
    const agent = yaml.load(templates.agentConfig); agent.hosts[0].networkConfig = { interfaces: [] };
    await expect(okd.saveTemplates('lab-okd', saved.revision, yaml.dump(install), yaml.dump(agent))).resolves.toHaveProperty('revision');
  });

  it('rejects profile deletion while its generation job is active', async () => {
    await okd.saveProfile(profile());
    await expect(okd.deleteProfile('lab-okd', () => true)).rejects.toMatchObject({ code: 'PROFILE_ACTIVE' });
    expect((await okd.getProfile('lab-okd')).id).toBe('lab-okd');
  });

  it('round-trips canonical disk hints unchanged', async () => {
    for (const [id, disk_hint] of [['wwn-hint', 'wwn:0x123'], ['serial-hint', 'serial:ABC-123'], ['device-hint', 'deviceName:/dev/vda']]) {
      await okd.saveProfile(profile({ id, hosts: [{ ...profile().hosts[0], disk_hint }] }));
      expect((await okd.getProfile(id)).hosts[0].disk_hint).toBe(disk_hint);
    }
  });

  it('rejects unknown, secret-like, malformed host, excessive worker, and invalid disk fields without echoing values', async () => {
    const secret = 'never-echo-this-value';
    const unknown = profile({ pull_secret: secret, surprise: true });
    const errors = okd.validateProfile(unknown);
    expect(errors).toEqual(expect.arrayContaining([
      { field: 'pull_secret', message: 'Secret-like fields are not allowed in profiles.' },
      { field: 'surprise', message: 'Unknown profile field.' },
    ]));
    expect(JSON.stringify(errors)).not.toContain(secret);
    await expect(okd.saveProfile(unknown)).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(okd.validateProfile(profile({ hosts: [null] })).map((e) => e.field)).toContain('hosts.0');
    expect(okd.validateProfile(profile({ hosts: [{ ...profile().hosts[0], extra: true }] })).map((e) => e.field)).toContain('hosts.0.extra');
    expect(okd.validateProfile(profile({ topology: 'standard', worker_count: 21 })).map((e) => e.field)).toContain('worker_count');

    for (const disk_hint of ['wwn:0x123', 'serial:ABC-123', 'deviceName:/dev/disk/by-path/pci-0000:01:00.0', 'deviceName:/dev/vda', 'deviceName:/dev/sda', 'deviceName:/dev/xvda', 'deviceName:/dev/nvme0n1', 'deviceName:/dev/mmcblk0']) {
      expect(okd.validateProfile(profile({ hosts: [{ ...profile().hosts[0], disk_hint }] }))).toEqual([]);
    }
    for (const disk_hint of ['', '/dev/disk/by-id/wwn-123', '/dev/vda', '/dev/sda', '/dev/nvme0n1', 'deviceName:/dev/vda1', 'deviceName:/dev/sda2', 'deviceName:/dev/nvme0n1p1', 'deviceName:/dev/mmcblk0p1', 'deviceName:/dev/mapper/root', 'deviceName:/tmp/disk', 'anything']) {
      expect(okd.validateProfile(profile({ hosts: [{ ...profile().hosts[0], disk_hint }] })).map((e) => e.field)).toContain('hosts.0.disk_hint');
    }
  });

  it('enforces baremetal VIP containment, uniqueness, and CIDR capacity', () => {
    const baremetal = profile({ platform: 'baremetal', api_vip: '192.168.7.20', ingress_vip: '192.168.7.21' });
    expect(okd.validateProfile(baremetal)).toEqual([]);
    expect(okd.validateProfile({ ...baremetal, api_vip: '10.0.0.1' }).map((e) => e.field)).toContain('api_vip');
    expect(okd.validateProfile({ ...baremetal, api_vip: '192.168.7.10' }).map((e) => e.field)).toContain('api_vip');
    expect(okd.validateProfile({ ...baremetal, ingress_vip: '192.168.7.20' }).map((e) => e.field)).toContain('ingress_vip');
    const tooSmall = { ...baremetal, machine_network: '192.168.7.8/30', rendezvous_ip: '192.168.7.9', api_vip: '192.168.7.10', ingress_vip: '192.168.7.11', hosts: [{ ...baremetal.hosts[0], ipv4: '192.168.7.9' }] };
    expect(okd.validateProfile(tooSmall).map((e) => e.field)).toContain('machine_network');
  });

  it('rejects symlinked profile and artifact directories', async () => {
    const profiles = path.join(root, 'config', 'okd', 'profiles');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(profiles, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(profiles, 'lab-okd'), 'dir');
    await expect(okd.getProfile('lab-okd')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(okd.saveProfile(profile())).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(okd.deleteProfile('lab-okd')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    const safe = profile({ id: 'safe-okd' });
    await okd.saveProfile(safe);
    const artifactRoot = path.join(root, 'assets', 'okd');
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(artifactRoot, 'safe-okd'), 'dir');
    await expect(okd.deleteProfile('safe-okd')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect((await okd.getProfile('safe-okd')).id).toBe('safe-okd');
  });

  it('refuses metadata deletion while artifact versions exist', async () => {
    // Phase 1 has no artifact producer, so this tests the immediate directory
    // guard only; add locking with the producer in a later phase.
    await okd.saveProfile(profile());
    fs.mkdirSync(path.join(root, 'assets', 'okd', 'lab-okd', 'v1'), { recursive: true });
    await expect(okd.deleteProfile('lab-okd')).rejects.toMatchObject({ code: 'HAS_ARTIFACTS' });
    expect((await okd.getProfile('lab-okd')).id).toBe('lab-okd');
  });

  it('validates persisted data before returning it', async () => {
    const saved = await okd.saveProfile(profile());
    const file = path.join(root, 'config', 'okd', 'profiles', 'lab-okd', 'profile.yml');
    fs.writeFileSync(file, yaml.dump({ ...saved, unexpected: 'stored data' }));
    await expect(okd.getProfile('lab-okd')).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
  });
});
