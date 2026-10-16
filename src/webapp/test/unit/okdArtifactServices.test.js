import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createArtifactService, rewriteBootScript } = require('../../services/okdArtifactServices.js');
const { COMPATIBILITY_RECORD } = require('../../services/okdServices.js');
const release = COMPATIBILITY_RECORD.release;
const profile = { id: 'lab-okd', release, revision: 'a'.repeat(64), boot_mode: 'pxe', asset_url: 'https://boot.example/' };
const job = (mediaVersion = 'v1') => ({ mediaVersion, installerArchiveSha256: 'b'.repeat(64), installerBinarySha256: 'c'.repeat(64) });
let root;

function service(overrides = {}) {
  return createArtifactService({ assetsRoot: path.join(root, 'assets'), configRoot: path.join(root, 'config'), now: () => '2026-10-16T00:00:00.000Z', ...overrides });
}
function workspace(mode = 'pxe') {
  const dir = fs.mkdtempSync(path.join(root, 'workspace-'));
  fs.writeFileSync(path.join(dir, 'install-config.yaml'), 'pullSecret: private');
  if (mode === 'iso') fs.writeFileSync(path.join(dir, 'agent.x86_64.iso'), 'iso image');
  else {
    const boot = path.join(dir, 'boot-artifacts'); fs.mkdirSync(boot);
    for (const [name, value] of [['agent.x86_64-vmlinuz', 'kernel'], ['agent.x86_64-initrd.img', 'initrd'], ['agent.x86_64-rootfs.img', 'rootfs']]) fs.writeFileSync(path.join(boot, name), value);
    fs.writeFileSync(path.join(boot, 'agent.x86_64.ipxe'), fs.readFileSync(new URL('../fixtures/agent-native-source.ipxe', import.meta.url)));
  }
  return dir;
}
async function buffer(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
function tarMembers(gzip) {
  const tar = zlib.gunzipSync(gzip); const members = new Map(); let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some(Boolean)) {
    const header = tar.subarray(offset, offset + 512); const read = (start, length) => header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '');
    const name = [read(345, 155), read(0, 100)].filter(Boolean).join('/'); const size = Number.parseInt(read(124, 12).trim() || '0', 8);
    offset += 512; members.set(name, tar.subarray(offset, offset + size)); offset += Math.ceil(size / 512) * 512;
  }
  return members;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'okd-artifacts-')); fs.mkdirSync(path.join(root, 'assets')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('release/media-version artifacts', () => {
  it('finalizes immutable PXE files and exports a streamed portable bundle', async () => {
    const svc = service(); const version = await svc.finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe', publicBaseUrl: profile.asset_url });
    expect(version).toMatchObject({ profileId: 'lab-okd', release, mediaVersion: 'v1', versionId: 'v1', mode: 'pxe', productionOrigin: 'https://boot.example/', baseUrl: `https://boot.example/okd/lab-okd/${release}/v1/` });
    const dir = path.join(root, 'assets/okd/lab-okd', release, 'v1');
    expect(fs.readdirSync(dir).sort()).toEqual(['SHA256SUMS', 'agent.x86_64-initrd.img', 'agent.x86_64-rootfs.img', 'agent.x86_64-vmlinuz', 'boot.ipxe', 'manifest.json']);
    const boot = fs.readFileSync(path.join(dir, 'boot.ipxe'), 'utf8');
    for (const name of ['agent.x86_64-vmlinuz', 'agent.x86_64-initrd.img', 'agent.x86_64-rootfs.img']) expect(boot).toContain(`https://boot.example/okd/lab-okd/${release}/v1/${name}`);
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).not.toMatch(/pullSecret|workspace|private/);

    const bundle = await svc.openPxeBundle('lab-okd', release, 'v1'); const members = tarMembers(await buffer(bundle.stream));
    const prefix = `okd/lab-okd/${release}/v1/`;
    expect([...members.keys()].sort()).toEqual(fs.readdirSync(dir).map((name) => prefix + name).sort());
    expect(members.get(prefix + 'boot.ipxe').toString()).toBe(boot);
    expect(bundle.name).toBe(`lab-okd-${release}-v1.tar.gz`);
  });

  it('finalizes ISO without an origin and opens it only through release/vN identity', async () => {
    const svc = service(); await svc.finalizeArtifacts({ workspace: workspace('iso'), profile: { ...profile, boot_mode: 'iso', asset_url: '' }, job: job('v2'), mode: 'iso', publicBaseUrl: null });
    const iso = await svc.openIso('lab-okd', release, 'v2');
    try { expect((await iso.handle.readFile()).toString()).toBe('iso image'); } finally { await iso.handle.close(); }
    expect((await svc.listAssets())[0].files[0].portalPath).toBe(`/okd/lab-okd/${release}/v2/iso`);
  });

  it('rejects traversal, malformed versions, symlink parents, duplicate finalization, and checksum changes', async () => {
    const svc = service(); await svc.finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe', publicBaseUrl: profile.asset_url });
    await expect(svc.readVersion('../lab', release, 'v1')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.readVersion('lab-okd', '../release', 'v1')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.readVersion('lab-okd', release, '1')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe', publicBaseUrl: profile.asset_url })).rejects.toMatchObject({ code: 'VERSION_EXISTS' });
    const sums = path.join(root, 'assets/okd/lab-okd', release, 'v1/SHA256SUMS'); fs.appendFileSync(sums, 'forged\n');
    await expect(svc.readVersion('lab-okd', release, 'v1')).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });

    const outside = path.join(root, 'outside'); fs.mkdirSync(outside); const profileDir = path.join(root, 'assets/okd/evil'); fs.symlinkSync(outside, profileDir);
    await expect(svc.finalizeArtifacts({ workspace: workspace(), profile: { ...profile, id: 'evil' }, job: job(), mode: 'pxe', publicBaseUrl: profile.asset_url })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects symlinked source files and non-exact iPXE references', async () => {
    const dir = workspace(); const kernel = path.join(dir, 'boot-artifacts/agent.x86_64-vmlinuz'); fs.rmSync(kernel); fs.symlinkSync(path.join(dir, 'install-config.yaml'), kernel);
    await expect(service().finalizeArtifacts({ workspace: dir, profile, job: job(), mode: 'pxe', publicBaseUrl: profile.asset_url })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    const fixture = fs.readFileSync(new URL('../fixtures/agent-native-source.ipxe', import.meta.url), 'utf8');
    expect(() => rewriteBootScript(fixture.replace(' initrd=initrd', ''), COMPATIBILITY_RECORD.outputs.pxe, 'https://boot.example/okd/lab/release/v1/')).toThrowError(expect.objectContaining({ code: 'BOOT_SCRIPT_INVALID' }));
  });

  it('fails a bundle stream if a finalized member changes after authorization', async () => {
    const svc = service(); await svc.finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe', publicBaseUrl: profile.asset_url });
    const bundle = await svc.openPxeBundle('lab-okd', release, 'v1');
    fs.writeFileSync(path.join(root, 'assets/okd/lab-okd', release, 'v1/agent.x86_64-vmlinuz'), 'forged');
    await expect(buffer(bundle.stream)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it('retains readable legacy UUID artifacts without rewriting bytes', async () => {
    const id = '11111111-1111-1111-1111-111111111111'; const dir = path.join(root, 'assets/okd/lab-okd', id); fs.mkdirSync(dir, { recursive: true });
    const content = '#!ipxe\nchain https://old.example/immutable\n'; const entry = { role: 'ipxe', name: 'boot.ipxe', size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') };
    fs.writeFileSync(path.join(dir, entry.name), content); fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, profileId: 'lab-okd', versionId: id, jobId: id, release, mode: 'pxe', publicBaseUrl: 'https://old.example/', files: [entry], createdAt: '2025-01-01T00:00:00Z' }));
    const listed = await service().listVersions('lab-okd'); expect(listed[0]).toMatchObject({ legacy: true, versionId: id });
    expect(fs.readFileSync(path.join(dir, entry.name), 'utf8')).toBe(content);
  });

  it('opens a legacy ISO through its two-segment compatibility identity', async () => {
    const id = '22222222-2222-2222-2222-222222222222'; const dir = path.join(root, 'assets/okd/lab-okd', id); fs.mkdirSync(dir, { recursive: true });
    const content = 'legacy iso'; const entry = { role: 'iso', name: 'agent.iso', size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') };
    fs.writeFileSync(path.join(dir, entry.name), content); fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, profileId: 'lab-okd', versionId: id, jobId: id, release, mode: 'iso', publicBaseUrl: 'https://old.example/', files: [entry], createdAt: '2025-01-01T00:00:00Z' }));
    const iso = await service().openIso('lab-okd', id);
    try { expect((await iso.handle.readFile()).toString()).toBe(content); expect(iso.name).toBe(`lab-okd-${release}-${id}.iso`); } finally { await iso.handle.close(); }
  });
});

describe('publication', () => {
  it('uses release/vN menu URLs and rolls the pointer back if menu writing fails', async () => {
    const stable = service(); await stable.finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe', publicBaseUrl: profile.asset_url });
    await stable.publish('lab-okd', release, 'v1'); const pointer = path.join(root, 'config/okd/publications/lab-okd.json'); const before = fs.readFileSync(pointer, 'utf8');
    expect(fs.readFileSync(path.join(root, 'config/menus/local/okd.ipxe'), 'utf8')).toContain(`chain https://boot.example/okd/lab-okd/${release}/v1/boot.ipxe`);
    await stable.finalizeArtifacts({ workspace: workspace(), profile, job: job('v2'), mode: 'pxe', publicBaseUrl: profile.asset_url });
    const failing = service({ writeMenu: async () => { throw new Error('failure'); } });
    await expect(failing.publish('lab-okd', release, 'v2')).rejects.toThrow('failure'); expect(fs.readFileSync(pointer, 'utf8')).toBe(before);
  });
});
