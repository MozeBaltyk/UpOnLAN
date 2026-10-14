import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createArtifactService, rewriteBootScript } = require('../../services/okdArtifactServices.js');
const { COMPATIBILITY_RECORD } = require('../../services/okdServices.js');
let root;

const profile = { id: 'lab-okd', revision: 'a'.repeat(64) };
function job(id = '12345678-1234-1234-1234-123456789abc') {
  return { id, installerArchiveSha256: 'b'.repeat(64), installerBinarySha256: 'c'.repeat(64) };
}
function service(overrides = {}) {
  return createArtifactService({
    assetsRoot: path.join(root, 'assets'), configRoot: path.join(root, 'config'),
    publicBaseUrl: 'https://pxe.example.com/', now: () => '2026-10-13T12:00:00.000Z', ...overrides,
  });
}
function workspace(mode = 'pxe') {
  const dir = fs.mkdtempSync(path.join(root, 'workspace-'));
  fs.writeFileSync(path.join(dir, 'install-config.yaml'), 'private pullSecret: never-copy');
  fs.writeFileSync(path.join(dir, 'agent-config.yaml'), 'private config');
  if (mode === 'pxe') {
    const artifacts = path.join(dir, 'boot-artifacts'); fs.mkdirSync(artifacts);
    fs.writeFileSync(path.join(artifacts, 'agent.x86_64-vmlinuz'), 'kernel');
    fs.writeFileSync(path.join(artifacts, 'agent.x86_64-initrd.img'), 'initrd');
    fs.writeFileSync(path.join(artifacts, 'agent.x86_64-rootfs.img'), 'rootfs');
    fs.writeFileSync(path.join(artifacts, 'agent.x86_64.ipxe'), fs.readFileSync(new URL('../fixtures/agent-native-source.ipxe', import.meta.url)));
  } else fs.writeFileSync(path.join(dir, 'agent.x86_64.iso'), 'iso image');
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'okd-artifacts-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'config', 'menus', 'local'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('OKD immutable artifact finalization', () => {
  it('rejects a symlinked boot-artifacts directory and malformed named initrd syntax', async () => {
    const dir = workspace(); fs.renameSync(path.join(dir, 'boot-artifacts'), path.join(dir, 'outside')); fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'boot-artifacts'));
    await expect(service().finalizeArtifacts({ workspace: dir, profile, job: job(), mode: 'pxe' })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    const fixture = fs.readFileSync(new URL('../fixtures/agent-native-source.ipxe', import.meta.url), 'utf8');
    for (const invalid of [fixture.replace('--name initrd', '--name wrong'), fixture.replace(' initrd=initrd', ''), fixture.replace('boot\n', 'initrd --name initrd https://other.invalid/evil\nboot\n')]) {
      expect(() => rewriteBootScript(invalid, COMPATIBILITY_RECORD.outputs.pxe, 'https://pxe.example.com/immutable/')).toThrowError(expect.objectContaining({ code: 'BOOT_SCRIPT_INVALID' }));
    }
  });
  it('verifies, checksums, rewrites, and atomically publishes only expected PXE files', async () => {
    const svc = service();
    const version = await svc.finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe' });
    expect(version).toMatchObject({ profileId: 'lab-okd', versionId: job().id, jobId: job().id, mode: 'pxe', active: false });
    expect(version.files.map((file) => file.role).sort()).toEqual(['initrd', 'ipxe', 'kernel', 'rootfs']);
    expect(version.files.every((file) => file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);

    const dir = path.join(root, 'assets', 'okd', 'lab-okd', job().id);
    expect(fs.readdirSync(dir).sort()).toEqual(['agent.x86_64-initrd.img', 'agent.x86_64-rootfs.img', 'agent.x86_64-vmlinuz', 'boot.ipxe', 'manifest.json']);
    const boot = fs.readFileSync(path.join(dir, 'boot.ipxe'), 'utf8');
    expect(boot).toContain('initrd --name initrd https://');
    expect(boot).toContain('initrd=initrd');
    expect(boot).toContain('rd.neednet=1 console=tty0');
    for (const name of ['agent.x86_64-vmlinuz', 'agent.x86_64-initrd.img', 'agent.x86_64-rootfs.img']) {
      expect(boot).toContain(`https://pxe.example.com/okd/lab-okd/${job().id}/${name}`);
      expect(boot).not.toContain(`installer.invalid/output/${name}`);
    }
    const stored = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    expect(version.files.find((file) => file.role === 'ipxe')).toMatchObject({
      size: Buffer.byteLength(boot), sha256: crypto.createHash('sha256').update(boot).digest('hex'),
    });
    expect(stored).not.toContain('workspace');
    expect(stored).not.toContain('never-copy');
    expect(fs.readdirSync(path.dirname(dir)).some((name) => name.startsWith('.'))).toBe(false);
    await expect(svc.finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe' })).rejects.toMatchObject({ code: 'VERSION_EXISTS' });
  });

  it.each(['missing', 'empty', 'symlink'])('rejects a %s expected output without creating a version', async (kind) => {
    const dir = workspace();
    const kernel = path.join(dir, 'boot-artifacts', 'agent.x86_64-vmlinuz');
    if (kind === 'missing') fs.rmSync(kernel);
    if (kind === 'empty') fs.writeFileSync(kernel, '');
    if (kind === 'symlink') { fs.rmSync(kernel); fs.symlinkSync(path.join(dir, 'install-config.yaml'), kernel); }
    await expect(service().finalizeArtifacts({ workspace: dir, profile, job: job(), mode: 'pxe' })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(fs.existsSync(path.join(root, 'assets', 'okd', 'lab-okd', job().id))).toBe(false);
  });

  it('rejects unexpected compatibility mappings and incomplete boot references', async () => {
    const badRecord = { ...COMPATIBILITY_RECORD, outputs: { ...COMPATIBILITY_RECORD.outputs, pxe: { ...COMPATIBILITY_RECORD.outputs.pxe, extra: 'unexpected' } } };
    await expect(service({ record: badRecord }).finalizeArtifacts({ workspace: workspace(), profile, job: job(), mode: 'pxe' }))
      .rejects.toMatchObject({ code: 'OUTPUT_MAPPING_INVALID' });
    const dir = workspace();
    fs.writeFileSync(path.join(dir, 'boot-artifacts', 'agent.x86_64.ipxe'), '#!ipxe\nkernel agent.x86_64-vmlinuz\n');
    await expect(service().finalizeArtifacts({ workspace: dir, profile, job: job(), mode: 'pxe' }))
      .rejects.toMatchObject({ code: 'BOOT_SCRIPT_INVALID' });
  });

  it.each([
    ['HTTP/query kernel', 'kernel http://old.invalid/agent.x86_64-kernel?mutable=1 coreos.live.rootfs_url=https://pxe.example.com/okd/lab-okd/version/agent.x86_64-rootfs.img\ninitrd https://pxe.example.com/okd/lab-okd/version/agent.x86_64-initrd.img'],
    ['another-version query', 'kernel https://other.invalid/latest/agent.x86_64-kernel?v=old coreos.live.rootfs_url=https://pxe.example.com/okd/lab-okd/version/agent.x86_64-rootfs.img\ninitrd https://pxe.example.com/okd/lab-okd/version/agent.x86_64-initrd.img'],
    ['suffix variant', 'kernel https://pxe.example.com/okd/lab-okd/version/agent.x86_64-kernel.backup coreos.live.rootfs_url=https://pxe.example.com/okd/lab-okd/version/agent.x86_64-rootfs.img\ninitrd https://pxe.example.com/okd/lab-okd/version/agent.x86_64-initrd.img'],
    ['duplicate stale rootfs', 'kernel https://pxe.example.com/okd/lab-okd/version/agent.x86_64-kernel coreos.live.rootfs_url=https://pxe.example.com/okd/lab-okd/version/agent.x86_64-rootfs.img coreos.live.rootfs_url=http://old.invalid/agent.x86_64-rootfs.img\ninitrd https://pxe.example.com/okd/lab-okd/version/agent.x86_64-initrd.img'],
  ])('rejects non-immutable boot script references: %s', (_name, body) => {
    expect(() => rewriteBootScript(`#!ipxe\n${body}\nboot\n`, COMPATIBILITY_RECORD.outputs.pxe, 'https://pxe.example.com/okd/lab-okd/version/'))
      .toThrowError(expect.objectContaining({ code: 'BOOT_SCRIPT_INVALID' }));
  });

  it('finalizes ISO under its release-specific filename without copying private config', async () => {
    const version = await service().finalizeArtifacts({ workspace: workspace('iso'), profile, job: job(), mode: 'iso' });
    expect(version).toMatchObject({ mode: 'iso', isoUrl: `https://pxe.example.com/okd/lab-okd/${job().id}/agent.x86_64.iso` });
    const dir = path.join(root, 'assets', 'okd', 'lab-okd', job().id);
    expect(fs.readdirSync(dir).sort()).toEqual(['agent.x86_64.iso', 'manifest.json']);
    expect(version.files[0].sha256).toBe(crypto.createHash('sha256').update('iso image').digest('hex'));
  });
});

describe('OKD publication lifecycle', () => {
  it('lists only valid manifests and enforces publish, activate, unpublish, and deletion rules', async () => {
    const svc = service();
    const first = job('11111111-1111-1111-1111-111111111111');
    const second = job('22222222-2222-2222-2222-222222222222');
    const iso = job('33333333-3333-3333-3333-333333333333');
    await svc.finalizeArtifacts({ workspace: workspace(), profile, job: first, mode: 'pxe' });
    await svc.finalizeArtifacts({ workspace: workspace(), profile, job: second, mode: 'pxe' });
    await svc.finalizeArtifacts({ workspace: workspace('iso'), profile, job: iso, mode: 'iso' });
    fs.mkdirSync(path.join(root, 'assets', 'okd', 'lab-okd', '44444444-4444-4444-4444-444444444444'));
    fs.writeFileSync(path.join(root, 'assets', 'okd', 'lab-okd', '44444444-4444-4444-4444-444444444444', 'manifest.json'), '{}');
    expect(await svc.listVersions('lab-okd')).toHaveLength(3);

    await expect(svc.publish('lab-okd', iso.id)).rejects.toMatchObject({ code: 'ISO_NOT_PUBLISHABLE' });
    await svc.publish('lab-okd', second.id);
    let versions = await svc.listVersions('lab-okd');
    expect(versions.find((item) => item.versionId === second.id).active).toBe(true);
    const menu = path.join(root, 'config', 'menus', 'local', 'okd.ipxe');
    expect(fs.readFileSync(menu, 'utf8')).toContain(`chain https://pxe.example.com/okd/lab-okd/${second.id}/boot.ipxe`);

    await svc.publish('lab-okd', first.id);
    versions = await svc.listVersions('lab-okd');
    expect(versions.find((item) => item.versionId === first.id).active).toBe(true);
    await expect(svc.deleteVersion('lab-okd', first.id, true)).rejects.toMatchObject({ code: 'VERSION_ACTIVE' });
    await expect(svc.deleteVersion('lab-okd', second.id, false)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await svc.deleteVersion('lab-okd', second.id, true);
    expect(fs.existsSync(path.join(root, 'assets', 'okd', 'lab-okd', second.id))).toBe(false);

    fs.writeFileSync(path.join(root, 'config', 'menus', 'local', 'unrelated.ipxe'), '#!ipxe\n');
    await svc.unpublish('lab-okd');
    expect(fs.existsSync(menu)).toBe(false);
    expect(fs.existsSync(path.join(root, 'config', 'menus', 'local', 'unrelated.ipxe'))).toBe(true);
    await svc.deleteVersion('lab-okd', first.id, true);
    await svc.deleteVersion('lab-okd', iso.id, true);
  });

  it('rolls pointer and menu back on regeneration failure, then reconciles an interrupted menu', async () => {
    const stable = service();
    const first = job('11111111-1111-1111-1111-111111111111');
    const second = job('22222222-2222-2222-2222-222222222222');
    await stable.finalizeArtifacts({ workspace: workspace(), profile, job: first, mode: 'pxe' });
    await stable.finalizeArtifacts({ workspace: workspace(), profile, job: second, mode: 'pxe' });
    await stable.publish('lab-okd', first.id);
    const pointer = path.join(root, 'config', 'okd', 'publications', 'lab-okd.json');
    const menu = path.join(root, 'config', 'menus', 'local', 'okd.ipxe');
    const previousPointer = fs.readFileSync(pointer, 'utf8');
    const previousMenu = fs.readFileSync(menu, 'utf8');
    const failing = service({ writeMenu: async () => { throw new Error('/private/menu failure'); } });

    await expect(failing.publish('lab-okd', second.id)).rejects.toThrow();
    expect(fs.readFileSync(pointer, 'utf8')).toBe(previousPointer);
    expect(fs.readFileSync(menu, 'utf8')).toBe(previousMenu);
    await expect(failing.unpublish('lab-okd')).rejects.toThrow();
    expect(fs.readFileSync(pointer, 'utf8')).toBe(previousPointer);
    expect(fs.readFileSync(menu, 'utf8')).toBe(previousMenu);

    fs.writeFileSync(menu, '#!ipxe\nstale interrupted menu\n');
    await stable.listVersions('lab-okd');
    expect(fs.readFileSync(menu, 'utf8')).toBe(previousMenu);
  });
});
