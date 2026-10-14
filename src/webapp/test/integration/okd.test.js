import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';
import { createFixtureRoot } from '../helpers/fixtures.js';

const require = createRequire(import.meta.url);

const PASS = 'secret';
let ctx;

function profile() {
  return {
    id: 'socket-okd', release: '5.0.0-okd-scos.1', platform: 'none', topology: 'sno',
    cluster_name: 'socket', base_domain: 'example.com', machine_network: '192.168.7.0/24',
    rendezvous_ip: '192.168.7.10', ssh_public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey',
    worker_count: 0, api_vip: '', ingress_vip: '',
    hosts: [{ hostname: 'master-0', role: 'control-plane', mac: '02:00:00:00:00:10', ipv4: '192.168.7.10', interface: 'eno1', disk_hint: 'wwn:0x123' }],
  };
}

function request(socket, event, ...args) {
  return new Promise((resolve) => socket.emit(event, ...args, resolve));
}

afterEach(async () => { if (ctx) { await ctx.close(); ctx = null; } });

describe('OKD socket handlers', () => {
  it('acknowledges create/update while downloads are blocked, shares release work, catches failures and survives disconnect', async () => {
    const { createToolService } = require('../../services/okdToolServices.js');
    const calls = []; const reject = {}; let preparations = 0;
    const service = createToolService({ configRoot: path.join(createFixtureRoot(), 'config'), download: (url) => {
      const name = url.includes('openshift-client') ? 'oc' : 'installer'; calls.push(name);
      return new Promise((_resolve, fail) => { reject[name] = fail; });
    } });
    const toolService = { installTools: (release) => { preparations++; expect(release).toBe(profile().release); return service.installAll(); }, getToolStatus: () => service.getStatus() };
    ctx = await bootApp({ pass: PASS, toolService });
    let socket = ctx.connectClient({ auth: { token: PASS } }); await once(socket, 'connect');
    try {
      expect(await request(socket, 'okd:save', { profile: { ...profile(), release: '4.22.0-okd-scos.9' } })).toMatchObject({ ok: false });
      expect(calls).toEqual([]);
      const saved = await socket.timeout(1000).emitWithAck('okd:save', { profile: profile() });
      expect(saved).toMatchObject({ ok: true, data: { release: profile().release, revision: expect.any(String) } });
      const updated = await socket.timeout(1000).emitWithAck('okd:save', { profile: profile(), existingId: saved.data.id, expectedRevision: saved.data.revision });
      expect(updated.ok).toBe(true);
      expect((await socket.timeout(1000).emitWithAck('okd:save', { profile: { ...profile(), id: 'second-profile' } })).ok).toBe(true);
      for (let i = 0; calls.length < 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(calls.sort()).toEqual(['installer', 'oc']);
      expect(await request(socket, 'okd:tools:status', profile().release)).toMatchObject({ data: { state: 'preparing', generationReady: false } });
      reject.oc(new Error('private download URL/credential must not escape'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await request(socket, 'okd:tools:status', profile().release)).toMatchObject({ data: { state: 'preparing', tools: { oc: { state: 'failed' }, installer: { state: 'preparing' } } } });
      // Failed sibling cannot release dedup while the installer is still running.
      expect((await socket.timeout(1000).emitWithAck('okd:save', { profile: profile(), existingId: updated.data.id, expectedRevision: updated.data.revision })).ok).toBe(true);
      expect(calls).toHaveLength(2);
      socket.close(); reject.installer(new Error('private failure'));
      const finished = await service.installAll();
      expect(finished).toMatchObject({ state: 'failed', generationReady: false, tools: { installer: { state: 'failed' }, oc: { state: 'failed' } } });
      expect(JSON.stringify(finished)).not.toContain('private');
      socket = ctx.connectClient({ auth: { token: PASS } }); await once(socket, 'connect');
      expect(await request(socket, 'okd:tools:status', profile().release)).toMatchObject({ data: { state: 'failed' } });
      const loaded = (await request(socket, 'okd:get', profile().id)).data;
      const prior = preparations;
      const templates = (await request(socket, 'okd:configs:get', { id: loaded.id, expectedRevision: loaded.revision })).data;
      const yamlSaved = await request(socket, 'okd:configs:save', { id: loaded.id, expectedRevision: loaded.revision, installConfig: templates.installConfig + '\n# YAML only\n', agentConfig: templates.agentConfig });
      expect(yamlSaved.ok).toBe(true); expect(preparations).toBe(prior);
      expect(await request(socket, 'okd:save', { profile: profile(), existingId: loaded.id, expectedRevision: loaded.revision })).toMatchObject({ ok: false, code: 'STALE_REVISION' });
      expect(preparations).toBe(prior);
      expect((await request(socket, 'okd:save', { profile: profile(), existingId: loaded.id, expectedRevision: yamlSaved.data.revision })).ok).toBe(true);
      for (let i = 0; calls.length < 4 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(calls).toHaveLength(4);
      const retry = service.installAll(); reject.oc(new Error('retry')); reject.installer(new Error('retry')); await retry;
    } finally { socket.close(); }
  });

  it.each(['websocket', 'polling'])('acknowledges escaped 1 MiB secret payloads over %s without weakening the raw limit', async (transport) => {
    ctx = await bootApp({ pass: PASS, persistenceReady: true });
    const socket = ctx.connectClient({ transports: [transport], auth: { token: PASS } });
    try {
      await once(socket, 'connect'); const limit = 1024 * 1024;
      const prefix = '{"auths":{"dummy.invalid":{"auth":"dummy"}}}';
      const secret = prefix + '\t'.repeat(limit - prefix.length);
      expect(Buffer.byteLength(JSON.stringify({ secret }))).toBeGreaterThan(limit);
      expect(await socket.timeout(5000).emitWithAck('okd:pull-secret:save', { secret })).toMatchObject({ ok: true, data: { status: 'ready' } });
      expect(await socket.timeout(5000).emitWithAck('okd:pull-secret:save', { secret: '\u0001'.repeat(limit) })).toMatchObject({ ok: false, code: 'PULL_SECRET_INVALID' });
      expect(await socket.timeout(5000).emitWithAck('okd:pull-secret:save', { secret: secret + ' ' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      expect(socket.connected).toBe(true);
    } finally { socket.close(); }
  });
  it('marks persisted active jobs interrupted at startup without a client connection', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    ctx = await bootApp({ fixtures: {
      [`config/okd/jobs/${id}.json`]: JSON.stringify({
        id, profileId: 'socket-okd', state: 'running', createdAt: '2026-10-13T00:00:00.000Z',
      }),
    } });
    const recordFile = path.join(ctx.root, 'config', 'okd', 'jobs', `${id}.json`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (JSON.parse(fs.readFileSync(recordFile, 'utf8')).state === 'interrupted') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.parse(fs.readFileSync(recordFile, 'utf8'))).toMatchObject({ state: 'interrupted', finishedAt: expect.any(String) });
  });

  it('provides authenticated structured CRUD results and rejects unauthenticated sockets', async () => {
    ctx = await bootApp({ pass: PASS, persistenceReady: true });
    const rejected = ctx.connectClient();
    await expect(once(rejected, 'connect')).rejects.toThrow('unauthorized');
    rejected.close();

    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');
    expect(await request(socket, 'okd:list')).toEqual({ ok: true, data: [] });
    const tools = await request(socket, 'okd:tools:status', '5.0.0-okd-scos.1');
    expect(tools).toMatchObject({ ok: true, data: { supportedReleases: ['4.22.0-okd-scos.9', '5.0.0-okd-scos.1'], release: '5.0.0-okd-scos.1', generationReady: false, tools: { installer: { required: true, ready: false }, oc: { required: true, ready: false } } } });
    expect(await request(socket, 'okd:tools:status', 'unknown')).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await request(socket, 'okd:tools:install', 'unknown')).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    const defaultReply = await request(socket, 'okd:pull-secret:status', {});
    expect(defaultReply).toEqual({ ok: true, data: { status: 'ready', source: 'default', exists: false, writable: true, disabledReasons: [] } });
    expect(JSON.stringify(defaultReply)).not.toMatch(/aWQ6|fake|"auths"|"raw"|"parsed"/);
    expect(fs.existsSync(path.join(ctx.root, 'config/okd/secrets/pull-secret'))).toBe(false);
    const pullSecret = '{"auths":{"quay.io":{"auth":"socket-private-credential"}}}';
    const pullReply = await request(socket, 'okd:pull-secret:save', { secret: pullSecret });
    expect(pullReply).toMatchObject({ ok: true, data: { status: 'ready', source: 'internal' } });
    expect(JSON.stringify(pullReply)).not.toContain('socket-private-credential');
    expect(await request(socket, 'okd:pull-secret:status', { extra: true })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    const pullFile = path.join(ctx.root, 'config/okd/secrets/pull-secret');
    expect(fs.statSync(path.dirname(pullFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(pullFile).mode & 0o777).toBe(0o600);
    expect(await request(socket, 'okd:jobs:status', 'socket-okd')).toMatchObject({ ok: true, data: { current: null, history: [] } });
    expect(await request(socket, 'okd:versions:list', 'socket-okd')).toEqual({ ok: true, data: [] });
    expect(await request(socket, 'okd:operations:monitor:status')).toEqual({ ok: true, data: null });
    expect(await request(socket, 'okd:operations:storage')).toMatchObject({ ok: true, data: { retention: { enabled: false, count: 0 } } });
    expect(await request(socket, 'okd:operations:diagnostics')).toMatchObject({ ok: true, data: { configured: { authentication: true }, active: { generation: false, monitoring: false } } });
    expect(await request(socket, 'okd:operations:probes', { profileId: 'socket-okd', host: '169.254.169.254' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect(await request(socket, 'okd:versions:publish', { profileId: 'socket-okd', versionId: '12345678-1234-1234-1234-123456789abc' })).toMatchObject({ ok: false, code: 'PUBLIC_URL_INVALID' });
    expect(await request(socket, 'okd:versions:delete', { profileId: 'socket-okd', versionId: '12345678-1234-1234-1234-123456789abc', confirmed: false })).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(await request(socket, 'okd:versions:unpublish', 'socket-okd')).toMatchObject({ ok: true, data: { profileId: 'socket-okd', active: false } });
    expect(await request(socket, 'okd:jobs:start', { profileId: 'socket-okd', revision: 'x', confirmed: false })).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    const saved = await request(socket, 'okd:save', { existingId: null, profile: profile() });
    expect(saved.ok).toBe(true);
    expect(await request(socket, 'okd:save', { existingId: null, profile: profile() })).toMatchObject({ ok: false, code: 'ALREADY_EXISTS' });
    const loaded = (await request(socket, 'okd:get', 'socket-okd')).data;
    expect(loaded.id).toBe('socket-okd');
    const configs = await request(socket, 'okd:configs:get', { id: 'socket-okd', expectedRevision: loaded.revision });
    expect(configs).toMatchObject({ ok: true, data: { revision: loaded.revision } });
    expect(yaml.load(configs.data.installConfig).pullSecret).toBe('{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}');
    expect(JSON.stringify(configs.data)).not.toContain('dXNlcjpwYXNz');
    expect(await request(socket, 'okd:configs:get', { id: 'socket-okd', expectedRevision: loaded.revision, extra: true })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    const edited = await request(socket, 'okd:configs:save', { id: 'socket-okd', expectedRevision: loaded.revision, installConfig: configs.data.installConfig + '\nadditionalTrustBundle: supplemental-test-ca\n', agentConfig: configs.data.agentConfig });
    expect(edited).toMatchObject({ ok: true, data: { revision: expect.not.stringMatching(new RegExp(`^${loaded.revision}$`)) } });
    expect(await request(socket, 'okd:configs:save', { id: 'socket-okd', expectedRevision: loaded.revision, installConfig: configs.data.installConfig, agentConfig: configs.data.agentConfig })).toMatchObject({ ok: false, code: 'STALE_REVISION' });
    expect((await request(socket, 'okd:save', { existingId: 'socket-okd', expectedRevision: 'stale', profile: profile() })).code).toBe('STALE_REVISION');
    const updated = await request(socket, 'okd:save', { existingId: 'socket-okd', expectedRevision: edited.data.revision, profile: { ...profile(), cluster_name: 'updated' } });
    expect(updated).toMatchObject({ ok: true, data: { id: 'socket-okd', cluster_name: 'updated', revision: expect.any(String) } });
    expect((await request(socket, 'okd:get', 'socket-okd')).data).toMatchObject({ cluster_name: 'updated', revision: updated.data.revision });
    expect((await request(socket, 'okd:list')).data).toHaveLength(1);
    expect(await request(socket, 'okd:delete', { id: 'socket-okd', confirmed: false })).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(await request(socket, 'okd:delete', 'socket-okd')).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    expect((await request(socket, 'okd:delete', { id: 'socket-okd', confirmed: true })).ok).toBe(true);
    const audit = fs.readFileSync(path.join(ctx.root, 'logs', 'okd', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('tool.install.request');
    expect(audit).toContain('tool.install.result');
    expect(audit).toContain('profile.save');
    expect(audit).toContain('profile.delete');
    expect(audit).toContain('pull-secret.save');
    expect(audit).toContain('"source":"internal"');
    expect(audit).not.toContain('socket-private-credential');
    expect(audit).not.toMatch(/AAAAC3|192\.168\.7|ssh_public_key|hosts/);
    socket.close();
  });

  it('keeps safe OKD endpoints open when both web credentials are empty', async () => {
    ctx = await bootApp({ user: '', pass: '' });
    const socket = ctx.connectClient();
    await once(socket, 'connect');
    expect(await request(socket, 'okd:list')).toEqual({ ok: true, data: [] });
    expect(await request(socket, 'okd:tools:status', '5.0.0-okd-scos.1')).toMatchObject({ ok: true, data: { generationReady: false } });
    expect(await request(socket, 'okd:pull-secret:status', {})).toMatchObject({ ok: true, data: { status: 'ready', source: 'default', exists: false, writable: false } });
    expect(await request(socket, 'okd:pull-secret:save', { secret: '{"auths":{"x":{"auth":"never-echo-this"}}}' })).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
    expect(await request(socket, 'okd:jobs:status', '')).toMatchObject({ ok: true, data: { current: null, history: [] } });
    expect(await request(socket, 'okd:pull-secret:save', { secret: '{"auths":{"x":{"auth":"partial-auth-secret"}}}' })).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
    expect(await request(socket, 'okd:jobs:start', { confirmed: false })).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(await request(socket, 'okd:versions:list', 'socket-okd')).toEqual({ ok: true, data: [] });
    expect(await request(socket, 'okd:operations:storage')).toMatchObject({ ok: true, data: { retention: { enabled: false } } });
    expect(await request(socket, 'okd:operations:probes', { profileId: 'socket-okd' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    socket.close();
  });

  it('matches global auth-disabled behavior when only one credential is configured', async () => {
    ctx = await bootApp({ user: 'admin', pass: '' });
    const socket = ctx.connectClient();
    await once(socket, 'connect');
    expect(await request(socket, 'okd:list')).toEqual({ ok: true, data: [] });
    expect(await request(socket, 'okd:jobs:status', '')).toMatchObject({ ok: true, data: { current: null, history: [] } });
    expect(await request(socket, 'okd:operations:diagnostics')).toMatchObject({ ok: true, data: { configured: { authentication: false } } });
    socket.close();
  });
});
