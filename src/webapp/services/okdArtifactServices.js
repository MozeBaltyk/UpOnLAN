'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { COMPATIBILITY_RECORD } = require('./okdServices');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[0-9a-f-]{16,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MODES = new Set(['pxe', 'iso']);

function coded(message, code) { return Object.assign(new Error(message), { code }); }
async function lstat(target) {
  try { return await fs.promises.lstat(target); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function assertSlug(value, label = 'profile') {
  if (!SLUG.test(value || '') || value.length > 63) throw coded(`Invalid ${label} ID.`, 'BAD_REQUEST');
}
function assertId(value, label = 'version') {
  if (!ID.test(value || '')) throw coded(`Invalid ${label} ID.`, 'BAD_REQUEST');
}
function cleanBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    return url.toString();
  } catch { throw coded('Configure a credential-free HTTPS OKD_PUBLIC_BASE_URL origin.', 'PUBLIC_URL_INVALID'); }
}
function expectedOutputs(record, mode) {
  if (!MODES.has(mode)) throw coded('Generation mode must be pxe or iso.', 'BAD_REQUEST');
  const outputs = record.outputs && record.outputs[mode];
  const roles = mode === 'pxe' ? ['kernel', 'initrd', 'rootfs', 'ipxe'] : ['iso'];
  if (!outputs || Object.keys(outputs).sort().join(',') !== [...roles].sort().join(',')) throw coded('Compatibility output mapping is invalid.', 'OUTPUT_MAPPING_INVALID');
  const names = roles.map((role) => outputs[role]);
  if (names.some((name) => typeof name !== 'string' || path.basename(name) !== name || !/^[A-Za-z0-9._-]+$/.test(name)) || new Set(names).size !== names.length) {
    throw coded('Compatibility output mapping is invalid.', 'OUTPUT_MAPPING_INVALID');
  }
  return outputs;
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
async function requireDirectory(target, createMode) {
  if (createMode !== undefined) await fs.promises.mkdir(target, { recursive: true, mode: createMode });
  const stat = await lstat(target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
}
async function sha256File(file) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1) throw coded('Artifact file is unsafe or empty.', 'ARTIFACT_INVALID');
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file, { fd: handle.fd, autoClose: false }), hash);
    return { size: stat.size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function copyVerified(source, destination) {
  const handle = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1) throw coded('Expected installer artifact is unsafe or empty.', 'ARTIFACT_INVALID');
    const hash = crypto.createHash('sha256');
    const tee = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    await pipeline(
      fs.createReadStream(source, { fd: handle.fd, autoClose: false }),
      tee,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o644 }),
    );
    return { size: stat.size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
function rewriteBootScript(text, outputs, publicUrl) {
  if (!text.startsWith('#!ipxe') || text.includes('\0')) throw coded('Installer iPXE output is invalid.', 'ARTIFACT_INVALID');
  let rewritten = text;
  for (const role of ['kernel', 'initrd', 'rootfs']) {
    const name = outputs[role];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reference = new RegExp(`(?:https?://[^\\s'"\\\\]*/|(?:\\.{0,2}/)[^\\s'"\\\\]*/)?${escaped}`, 'g');
    rewritten = rewritten.replace(reference, `${publicUrl}${name}`);
  }
  const expected = Object.fromEntries(['kernel', 'initrd', 'rootfs'].map((role) => [role, `${publicUrl}${outputs[role]}`]));
  const kernel = [...rewritten.matchAll(/^\s*kernel\s+(\S+)/gm)].map((match) => match[1]);
  const initrd = [...rewritten.matchAll(/^\s*initrd\s+(?:--name initrd\s+)?(\S+)\s*$/gm)].map((match) => match[1]);
  const initrdCommands = [...rewritten.matchAll(/^\s*initrd\s+/gm)];
  const rootfs = [...rewritten.matchAll(/(?:^|\s)coreos\.live\.rootfs_url=(\S+)/gm)].map((match) => match[1]);
  if (initrdCommands.length !== 1 || (rewritten.includes('--name initrd') && !/\sinitrd=initrd(?:\s|$)/m.test(rewritten))
    || kernel.length !== 1 || kernel[0] !== expected.kernel || initrd.length !== 1 || initrd[0] !== expected.initrd
    || rootfs.length !== 1 || rootfs[0] !== expected.rootfs) {
    throw coded('Installer iPXE output does not contain the exact immutable boot artifact URLs.', 'BOOT_SCRIPT_INVALID');
  }
  for (const role of ['kernel', 'initrd', 'rootfs']) {
    const escaped = outputs[role].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokens = rewritten.match(new RegExp(`[^\\s'"\\\\]*${escaped}[^\\s'"\\\\]*`, 'g')) || [];
    const allowed = role === 'rootfs' ? [`coreos.live.rootfs_url=${expected.rootfs}`] : [expected[role]];
    if (tokens.some((token) => !allowed.includes(token))) throw coded('Installer iPXE output contains a stale or mutable artifact reference.', 'BOOT_SCRIPT_INVALID');
  }
  return rewritten;
}

function createArtifactService({
  assetsRoot = process.env.UPONLAN_ASSETS || '/assets',
  configRoot = process.env.UPONLAN_CONFIG || '/config',
  publicBaseUrl = process.env.OKD_PUBLIC_BASE_URL || '',
  record = COMPATIBILITY_RECORD,
  now = () => new Date().toISOString(),
  writeMenu = (_file, _content, commit) => commit(),
} = {}) {
  const versionsRoot = path.join(assetsRoot, 'okd');
  const publicationsRoot = path.join(configRoot, 'okd', 'publications');
  const menuRoot = path.join(configRoot, 'menus', 'local');
  const menuFile = path.join(menuRoot, 'okd.ipxe');
  let mutation = Promise.resolve();
  const serialize = (fn) => { const next = mutation.then(fn, fn); mutation = next.catch(() => {}); return next; };

  function versionDir(profileId, versionId) {
    assertSlug(profileId); assertId(versionId);
    return path.join(versionsRoot, profileId, versionId);
  }
  function versionUrl(profileId, versionId) {
    return `${cleanBaseUrl(publicBaseUrl)}okd/${profileId}/${versionId}/`;
  }
  async function ensureRoots() {
    await requireDirectory(assetsRoot, 0o755);
    await requireDirectory(versionsRoot, 0o755);
  }
  async function ensurePublications() {
    await requireDirectory(configRoot, 0o700);
    await requireDirectory(path.join(configRoot, 'okd'), 0o700);
    await requireDirectory(publicationsRoot, 0o700);
  }
  async function ensureMenus() {
    await requireDirectory(configRoot, 0o700);
    await requireDirectory(path.join(configRoot, 'menus'), 0o755);
    await requireDirectory(menuRoot, 0o755);
  }
  async function safeWorkspace(workspace) {
    const resolved = path.resolve(workspace);
    const stat = await lstat(resolved);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw coded('Installer workspace is unsafe.', 'UNSAFE_PATH');
    return resolved;
  }
  async function finalizeArtifacts({ workspace, profile, job, mode = 'pxe' }) {
    return serialize(async () => {
      assertSlug(profile && profile.id); assertId(job && job.id, 'job');
      if (!SHA256.test(profile.revision || '') || !SHA256.test(job.installerArchiveSha256 || '') || !SHA256.test(job.installerBinarySha256 || '')) {
        throw coded('Artifact provenance is invalid.', 'ARTIFACT_INVALID');
      }
      const outputs = expectedOutputs(record, mode);
      const root = await safeWorkspace(workspace);
      const sourceRoot = mode === 'pxe' ? path.join(root, 'boot-artifacts') : root;
      await requireDirectory(sourceRoot);
      await ensureRoots();
      const profileRoot = path.join(versionsRoot, profile.id);
      await requireDirectory(profileRoot, 0o755);
      const versionId = job.id;
      const target = versionDir(profile.id, versionId);
      if (await lstat(target)) throw coded('Artifact version already exists.', 'VERSION_EXISTS');
      const staging = path.join(profileRoot, `.${versionId}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      await fs.promises.mkdir(staging, { mode: 0o700 });
      try {
        const files = [];
        const publicUrl = versionUrl(profile.id, versionId);
        for (const role of Object.keys(outputs)) {
          if (role === 'ipxe') continue;
          const source = path.resolve(sourceRoot, outputs[role]);
          if (path.dirname(source) !== sourceRoot) throw coded('Expected artifact escapes the workspace.', 'UNSAFE_PATH');
          const result = await copyVerified(source, path.join(staging, outputs[role]));
          files.push({ role, name: outputs[role], ...result });
        }
        if (mode === 'pxe') {
          const source = path.resolve(sourceRoot, outputs.ipxe);
          if (path.dirname(source) !== sourceRoot) throw coded('Expected artifact escapes the workspace.', 'UNSAFE_PATH');
          const handle = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          let script;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024 * 1024) throw coded('Installer iPXE output is unsafe or empty.', 'ARTIFACT_INVALID');
            script = await handle.readFile('utf8');
          } finally { await handle.close(); }
          const content = Buffer.from(rewriteBootScript(script, outputs, publicUrl));
          await fs.promises.writeFile(path.join(staging, 'boot.ipxe'), content, { flag: 'wx', mode: 0o644 });
          files.push({ role: 'ipxe', name: 'boot.ipxe', size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
        }
        files.sort((a, b) => a.role.localeCompare(b.role));
        const manifest = {
          schemaVersion: 1, profileId: profile.id, profileRevision: profile.revision,
          jobId: job.id, versionId, mode, release: record.release,
          releaseImage: record.releaseImage, releaseDigest: record.releaseDigest,
          compatibilityRevision: record.revision,
          installer: { archiveSha256: job.installerArchiveSha256, binarySha256: job.installerBinarySha256 },
          files, createdAt: now(),
        };
        await fs.promises.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
        await fs.promises.chmod(staging, 0o755);
        await fs.promises.rename(staging, target);
        return publicVersion(manifest, false);
      } catch (err) {
        await fs.promises.rm(staging, { recursive: true, force: true });
        if (err.code === 'ENOENT') throw coded('Expected installer artifact is missing.', 'ARTIFACT_INVALID');
        if (err.code === 'ELOOP') throw coded('Expected installer artifact is unsafe.', 'ARTIFACT_INVALID');
        throw err;
      }
    });
  }
  function validManifest(value, profileId, versionId) {
    if (!exactKeys(value, ['schemaVersion', 'profileId', 'profileRevision', 'jobId', 'versionId', 'mode', 'release', 'releaseImage', 'releaseDigest', 'compatibilityRevision', 'installer', 'files', 'createdAt'])
      || !exactKeys(value.installer, ['archiveSha256', 'binarySha256'])
      || value.schemaVersion !== 1 || value.profileId !== profileId || value.versionId !== versionId || value.jobId !== versionId
      || !MODES.has(value.mode) || !SHA256.test(value.profileRevision || '') || value.release !== record.release
      || value.releaseImage !== record.releaseImage || value.releaseDigest !== record.releaseDigest || value.compatibilityRevision !== record.revision
      || !value.installer || !SHA256.test(value.installer.archiveSha256 || '') || !SHA256.test(value.installer.binarySha256 || '')
      || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) || !Array.isArray(value.files)) return false;
    const outputs = expectedOutputs(record, value.mode);
    const expected = value.mode === 'pxe'
      ? { kernel: outputs.kernel, initrd: outputs.initrd, rootfs: outputs.rootfs, ipxe: 'boot.ipxe' }
      : { iso: outputs.iso };
    return value.files.length === Object.keys(expected).length && value.files.every((file) => exactKeys(file, ['role', 'name', 'size', 'sha256']) && expected[file.role] === file.name
      && Number.isSafeInteger(file.size) && file.size > 0 && SHA256.test(file.sha256 || ''));
  }
  async function readVersion(profileId, versionId) {
    const dir = versionDir(profileId, versionId);
    const dirStat = await lstat(dir);
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw coded('Artifact version not found.', 'NOT_FOUND');
    const manifestFile = path.join(dir, 'manifest.json');
    const stat = await lstat(manifestFile);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024 * 1024) throw coded('Artifact manifest is invalid.', 'INVALID_MANIFEST');
    let manifest;
    try { manifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8')); } catch { throw coded('Artifact manifest is invalid.', 'INVALID_MANIFEST'); }
    if (!validManifest(manifest, profileId, versionId)) throw coded('Artifact manifest is invalid.', 'INVALID_MANIFEST');
    const expectedNames = ['manifest.json', ...manifest.files.map((file) => file.name)].sort();
    if ((await fs.promises.readdir(dir)).sort().join('\0') !== expectedNames.join('\0')) throw coded('Artifact version contains unexpected files.', 'INVALID_MANIFEST');
    for (const file of manifest.files) {
      const actual = await sha256File(path.join(dir, file.name));
      if (actual.size !== file.size || actual.sha256 !== file.sha256) throw coded('Artifact checksum mismatch.', 'INVALID_MANIFEST');
    }
    return manifest;
  }
  function pointerFile(profileId) { assertSlug(profileId); return path.join(publicationsRoot, `${profileId}.json`); }
  async function readPointer(profileId) {
    await ensurePublications();
    const file = pointerFile(profileId);
    const stat = await lstat(file);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw coded('Publication pointer is invalid.', 'INVALID_PUBLICATION');
    let value;
    try { value = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { throw coded('Publication pointer is invalid.', 'INVALID_PUBLICATION'); }
    if (!exactKeys(value, ['profileId', 'versionId', 'activatedAt']) || value.profileId !== profileId || !ID.test(value.versionId || '') || typeof value.activatedAt !== 'string' || Number.isNaN(Date.parse(value.activatedAt))) throw coded('Publication pointer is invalid.', 'INVALID_PUBLICATION');
    return value;
  }
  function publicVersion(manifest, active) {
    const url = versionUrl(manifest.profileId, manifest.versionId);
    return { ...manifest, active, isoUrl: manifest.mode === 'iso' ? `${url}${record.outputs.iso.iso}` : null };
  }
  async function listVersions(profileId) {
    await reconcilePublications();
    assertSlug(profileId);
    const profileRoot = path.join(versionsRoot, profileId);
    const stat = await lstat(profileRoot);
    if (!stat) return [];
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded('OKD artifact directory is unsafe.', 'UNSAFE_PATH');
    const active = await readPointer(profileId);
    if (active) {
      const activeManifest = await readVersion(profileId, active.versionId);
      if (activeManifest.mode !== 'pxe') throw coded('Only PXE versions can be active.', 'INVALID_PUBLICATION');
    }
    const result = [];
    for (const versionId of await fs.promises.readdir(profileRoot)) {
      if (!ID.test(versionId)) continue;
      try { result.push(publicVersion(await readVersion(profileId, versionId), !!active && active.versionId === versionId)); } catch (err) {
        if (!['NOT_FOUND', 'INVALID_MANIFEST'].includes(err.code)) throw err;
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function atomicWrite(file, value, mode = 0o600) {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { await fs.promises.writeFile(temp, value, { flag: 'wx', mode }); await fs.promises.rename(temp, file); }
    finally { await fs.promises.rm(temp, { force: true }); }
  }
  async function readOwnedFile(file) {
    const stat = await lstat(file);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw coded('Owned publication file is unsafe.', 'UNSAFE_PATH');
    return fs.promises.readFile(file);
  }
  async function restoreOwnedFile(file, content, mode) {
    if (content === null) await fs.promises.rm(file, { force: true });
    else await atomicWrite(file, content, mode);
  }
  async function activePointers() {
    await ensurePublications();
    const pointers = [];
    for (const name of await fs.promises.readdir(publicationsRoot)) {
      if (!/^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.test(name)) continue;
      const profileId = name.slice(0, -5);
      const pointer = await readPointer(profileId);
      const manifest = await readVersion(profileId, pointer.versionId);
      if (manifest.mode !== 'pxe') throw coded('Only PXE versions can be active.', 'ISO_NOT_PUBLISHABLE');
      pointers.push(pointer);
    }
    return pointers.sort((a, b) => a.profileId.localeCompare(b.profileId));
  }
  async function regenerateMenu() {
    const pointers = await activePointers();
    await ensureMenus();
    if (!pointers.length) { await writeMenu(menuFile, null, () => fs.promises.rm(menuFile, { force: true })); return; }
    const lines = ['#!ipxe', 'menu OKD Agent PXE'];
    for (const pointer of pointers) lines.push(`item okd-${pointer.profileId} ${pointer.profileId}`);
    lines.push('choose okd_target || exit', 'goto ${okd_target}');
    for (const pointer of pointers) lines.push(`:okd-${pointer.profileId}`, `chain ${versionUrl(pointer.profileId, pointer.versionId)}boot.ipxe || exit`);
    const content = `${lines.join('\n')}\n`;
    await writeMenu(menuFile, content, () => atomicWrite(menuFile, content, 0o644));
  }
  async function publish(profileId, versionId) {
    return serialize(async () => {
      cleanBaseUrl(publicBaseUrl);
      const manifest = await readVersion(profileId, versionId);
      if (manifest.mode !== 'pxe') throw coded('ISO-only versions cannot be published to the boot menu.', 'ISO_NOT_PUBLISHABLE');
      await ensurePublications();
      await ensureMenus();
      const file = pointerFile(profileId);
      const previousPointer = await readOwnedFile(file);
      const previousMenu = await readOwnedFile(menuFile);
      const pointer = { profileId, versionId, activatedAt: now() };
      try {
        await atomicWrite(file, `${JSON.stringify(pointer, null, 2)}\n`);
        await regenerateMenu();
      } catch (err) {
        try { await restoreOwnedFile(file, previousPointer, 0o600); await restoreOwnedFile(menuFile, previousMenu, 0o644); }
        catch { throw coded('Publication update and rollback failed.', 'PUBLICATION_ROLLBACK_FAILED'); }
        throw err;
      }
      return publicVersion(manifest, true);
    });
  }
  async function unpublish(profileId) {
    return serialize(async () => {
      await ensurePublications();
      const file = pointerFile(profileId);
      await ensureMenus();
      const previousPointer = await readOwnedFile(file);
      const previousMenu = await readOwnedFile(menuFile);
      try {
        await fs.promises.rm(file, { force: true });
        await regenerateMenu();
      } catch (err) {
        try { await restoreOwnedFile(file, previousPointer, 0o600); await restoreOwnedFile(menuFile, previousMenu, 0o644); }
        catch { throw coded('Publication update and rollback failed.', 'PUBLICATION_ROLLBACK_FAILED'); }
        throw err;
      }
      return { profileId, active: false };
    });
  }
  async function deleteVersion(profileId, versionId, confirmed) {
    return serialize(async () => {
      if (confirmed !== true) throw coded('Confirm deletion of this inactive artifact version.', 'CONFIRMATION_REQUIRED');
      const pointer = await readPointer(profileId);
      if (pointer && pointer.versionId === versionId) throw coded('Unpublish or activate another version before deletion.', 'VERSION_ACTIVE');
      await readVersion(profileId, versionId);
      await fs.promises.rm(versionDir(profileId, versionId), { recursive: true });
      return { profileId, versionId };
    });
  }
  function reconcilePublications() { return serialize(() => regenerateMenu()); }
  return { finalizeArtifacts, listVersions, publish, unpublish, deleteVersion, regenerateMenu, reconcilePublications };
}

const service = createArtifactService();
module.exports = {
  createArtifactService, rewriteBootScript,
  finalizeArtifacts: service.finalizeArtifacts,
  listVersions: service.listVersions,
  publishVersion: service.publish,
  unpublishProfile: service.unpublish,
  deleteVersion: service.deleteVersion,
  reconcilePublications: service.reconcilePublications,
};
