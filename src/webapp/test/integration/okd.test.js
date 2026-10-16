import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const require = createRequire(import.meta.url);
const { COMPATIBILITY_RECORD } = require('../../services/okdServices.js');
const release = COMPATIBILITY_RECORD.release;
let ctx;
function profile(overrides = {}) {
  return {
    id: 'socket-okd', release, platform: 'none', topology: 'sno', cluster_name: 'socket', base_domain: 'example.com', machine_network: '192.168.7.0/24', rendezvous_ip: '192.168.7.10',
    ssh_public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8n96vOlUzgA2V4ueqs5IWkvw/kffw52WC3Mpr7J2Cu fixture', worker_count: 0, api_vip: '', ingress_vip: '',
    boot_mode: 'iso', asset_url: '', asset_certificate_bundle: '', additional_ca_bundle: '',
    hosts: [{ hostname: 'master-0', role: 'control-plane', mac: '02:00:00:00:00:10', ipv4: '192.168.7.10', interface: 'eno1', disk_hint: 'wwn:0x123' }], ...overrides,
  };
}
const request = (socket, event, ...args) => new Promise((resolve) => socket.emit(event, ...args, resolve));
afterEach(async () => { if (ctx) { await ctx.close(); fs.rmSync(ctx.root, { recursive: true, force: true }); ctx = null; } });

describe('OKD backend API', () => {
  it('round-trips profile-owned media settings and keeps removed Operations handlers unavailable', async () => {
    ctx = await bootApp({ pass: 'secret', persistenceReady: true }); const rejected = ctx.connectClient();
    await expect(once(rejected, 'connect')).rejects.toThrow('unauthorized'); rejected.close();
    const socket = ctx.connectClient({ auth: { token: 'secret' } }); await once(socket, 'connect');
    try {
      const saved = await request(socket, 'okd:save', { profile: profile() });
      expect(saved).toMatchObject({ ok: true, data: { boot_mode: 'iso', asset_url: '', revision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      const loaded = await request(socket, 'okd:get', 'socket-okd'); expect(loaded.data).toMatchObject(profile());
      const configs = await request(socket, 'okd:configs:get', { id: 'socket-okd', expectedRevision: saved.data.revision });
      expect(configs.data.installConfig).not.toContain('private'); expect(configs.data.agentConfig).not.toContain('bootArtifactsBaseURL');
      expect(await request(socket, 'okd:jobs:status', 'socket-okd')).toMatchObject({ ok: true, data: { current: null, history: [] } });
      for (const event of ['okd:operations:monitor:status', 'okd:operations:health', 'okd:operations:probes', 'okd:operations:storage', 'okd:operations:cleanup', 'okd:operations:diagnostics']) {
        await expect(socket.timeout(50).emitWithAck(event, {})).rejects.toThrow();
      }
      expect(await request(socket, 'okd:jobs:cancel', { profileId: 'socket-okd', release, mediaVersion: 'v1', extra: true })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      expect(await request(socket, 'okd:jobs:log', { profileId: 'socket-okd', release: '../bad', mediaVersion: 'v1' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      expect((await request(socket, 'okd:delete', { id: 'socket-okd', confirmed: true })).ok).toBe(true);
      const audit = fs.readFileSync(path.join(ctx.root, 'logs/okd/audit.jsonl'), 'utf8'); expect(audit).toMatch(/profile\.save/); expect(audit).toMatch(/profile\.delete/); expect(audit).not.toMatch(/ssh|192\.168|secret/);
    } finally { socket.close(); }
  });

  it('validates exact request shapes and explicit public CA input', async () => {
    ctx = await bootApp({ pass: 'secret', persistenceReady: true }); const socket = ctx.connectClient({ auth: { token: 'secret' } }); await once(socket, 'connect');
    try {
      expect(await request(socket, 'okd:certificates:validate', { pem: 'not pem' })).toMatchObject({ ok: false, code: 'CERTIFICATE_INVALID' });
      expect(await request(socket, 'okd:certificates:validate', { pem: '', extra: true })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      expect(await request(socket, 'okd:certificates:inspect', { assetUrl: 'https://127.0.0.1/' })).toMatchObject({ ok: false, code: 'PUBLIC_URL_INVALID' });
      expect(await request(socket, 'okd:certificates:confirm', { profileId: 'socket-okd' })).toMatchObject({ ok: true, data: { confirmed: true } });
      expect(await request(socket, 'okd:certificates:confirm', { profileId: 'socket-okd', pem: 'secret' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      expect(await request(socket, 'okd:jobs:preflight', { profileId: 'missing', revision: 'a'.repeat(64), mode: 'pxe' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      expect(await request(socket, 'okd:jobs:start', { profileId: 'missing', revision: 'a'.repeat(64), mode: 'iso', confirmed: true })).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
      const audit = fs.readFileSync(path.join(ctx.root, 'logs/okd/audit.jsonl'), 'utf8');
      expect(audit).toContain('certificate.confirm'); expect(audit).not.toMatch(/pem|secret/);
    } finally { socket.close(); }
  });

  it('recovers active generation records using profile/release/vN identity', async () => {
    const id = `socket-okd--${release}--v3`;
    ctx = await bootApp({ fixtures: { [`config/okd/jobs/${id}.json`]: JSON.stringify({ profileId: 'socket-okd', profileRevision: 'a'.repeat(64), mediaVersion: 'v3', release, mode: 'iso', state: 'running', createdAt: '2026-10-13T00:00:00.000Z', releaseImage: COMPATIBILITY_RECORD.releaseImage, releaseDigest: COMPATIBILITY_RECORD.releaseDigest, compatibilityRevision: COMPATIBILITY_RECORD.revision, installerArchiveSha256: 'b'.repeat(64), installerBinarySha256: 'c'.repeat(64) }) } });
    const file = path.join(ctx.root, 'config/okd/jobs', `${id}.json`);
    for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'running'; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ profileId: 'socket-okd', release, mediaVersion: 'v3', state: 'interrupted', finishedAt: expect.any(String) });
  });
});
