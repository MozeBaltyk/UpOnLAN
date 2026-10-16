'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const { COMPATIBILITY_RECORD } = require('./okdServices');
const { validateOrigin } = require('./localAssetSettings');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELEASE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const VERSION = /^v[1-9][0-9]*$/;
const LEGACY = /^[0-9a-f-]{16,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
function coded(message, code) { return Object.assign(new Error(message), { code }); }
function assert(value, pattern, label) { if (!pattern.test(value || '')) throw coded(`Invalid ${label}.`, 'BAD_REQUEST'); }
async function lstat(target) { try { return await fs.promises.lstat(target); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } }
async function directory(target, mode) { if (mode !== undefined) await fs.promises.mkdir(target, { recursive: true, mode }); const stat = await lstat(target); if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH'); }
async function safeDirectory(base, target, mode) {
  const root = path.resolve(base); const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
  if (mode !== undefined) await fs.promises.mkdir(root, { recursive: true, mode });
  const rootStat = await fs.promises.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (mode !== undefined) await fs.promises.mkdir(current, { mode }).catch((err) => { if (err.code !== 'EEXIST') throw err; });
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
  }
}
async function hashFile(file) {
  const opened = await require('./safeFile').openRegular(file); try { const hash = crypto.createHash('sha256'); await pipeline(opened.handle.createReadStream({ autoClose: false }), hash); return { size: opened.stat.size, sha256: hash.digest('hex') }; } finally { await opened.handle.close(); }
}
async function copy(source, destination) {
  const opened = await require('./safeFile').openRegular(source); try {
    if (!opened.stat.size) throw coded('Expected installer artifact is empty.', 'ARTIFACT_INVALID');
    const hash = crypto.createHash('sha256'); const tee = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    await pipeline(opened.handle.createReadStream({ autoClose: false }), tee, fs.createWriteStream(destination, { flags: 'wx', mode: 0o644 }));
    return { size: opened.stat.size, sha256: hash.digest('hex') };
  } finally { await opened.handle.close(); }
}
function outputs(record, mode) {
  if (!['pxe', 'iso'].includes(mode)) throw coded('Invalid generation mode.', 'BAD_REQUEST');
  const value = record.outputs[mode]; const roles = mode === 'pxe' ? ['kernel', 'initrd', 'rootfs', 'ipxe'] : ['iso'];
  if (!value || roles.some((role) => !/^[A-Za-z0-9._-]+$/.test(value[role] || ''))) throw coded('Compatibility output mapping is invalid.', 'OUTPUT_MAPPING_INVALID');
  return value;
}
function rewriteBootScript(text, names, baseUrl) {
  if (!text.startsWith('#!ipxe') || text.includes('\0')) throw coded('Installer iPXE output is invalid.', 'ARTIFACT_INVALID');
  let value = text;
  for (const role of ['kernel', 'initrd', 'rootfs']) value = value.replace(new RegExp(`(?:https?://[^\\s'"\\\\]*/|(?:\\.{0,2}/)[^\\s'"\\\\]*/)?${names[role].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `${baseUrl}${names[role]}`);
  const expected = Object.fromEntries(['kernel', 'initrd', 'rootfs'].map((role) => [role, `${baseUrl}${names[role]}`]));
  const kernel = [...value.matchAll(/^\s*kernel\s+(\S+)/gm)].map((m) => m[1]);
  const initrd = [...value.matchAll(/^\s*initrd\s+(?:--name initrd\s+)?(\S+)\s*$/gm)].map((m) => m[1]);
  const rootfs = [...value.matchAll(/(?:^|\s)coreos\.live\.rootfs_url=(\S+)/gm)].map((m) => m[1]);
  if (kernel.length !== 1 || kernel[0] !== expected.kernel || initrd.length !== 1 || initrd[0] !== expected.initrd || rootfs.length !== 1 || rootfs[0] !== expected.rootfs
    || (value.includes('--name initrd') && !/\sinitrd=initrd(?:\s|$)/m.test(value))) throw coded('Installer iPXE output does not contain the exact immutable boot artifact URLs.', 'BOOT_SCRIPT_INVALID');
  return value;
}
function tarHeader(name, size) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..') || Buffer.byteLength(name) > 255 || size > 0o77777777777) throw coded('Archive member is unsafe.', 'UNSAFE_ARCHIVE');
  let shortName = name; let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const split = name.indexOf('/', Math.max(1, name.length - 100));
    if (split < 1 || Buffer.byteLength(name.slice(0, split)) > 155) throw coded('Archive member is unsafe.', 'UNSAFE_ARCHIVE');
    prefix = name.slice(0, split); shortName = name.slice(split + 1);
  }
  const b = Buffer.alloc(512); const field = (value, offset, length) => b.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'ascii');
  field(shortName, 0, 100); field('0000644\0', 100, 8); field('0000000\0', 108, 8); field('0000000\0', 116, 8);
  field(`${size.toString(8).padStart(11, '0')}\0`, 124, 12); field('00000000000\0', 136, 12); b.fill(0x20, 148, 156); b[156] = 0x30; field('ustar\0', 257, 6); field('00', 263, 2);
  field(prefix, 345, 155);
  field(`${[...b].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8); return b;
}

function createArtifactService({ assetsRoot = process.env.UPONLAN_ASSETS || '/assets', configRoot = process.env.UPONLAN_CONFIG || '/config', record = COMPATIBILITY_RECORD, now = () => new Date().toISOString(), writeMenu = (_f, _c, commit) => commit() } = {}) {
  const root = path.join(assetsRoot, 'okd'); const publications = path.join(configRoot, 'okd', 'publications'); const menuRoot = path.join(configRoot, 'menus', 'local'); const menuFile = path.join(menuRoot, 'okd.ipxe');
  let mutation = Promise.resolve(); const serialize = (fn) => { const next = mutation.then(fn, fn); mutation = next.catch(() => {}); return next; };
  const dir = (profile, release, version) => path.join(root, profile, ...(version ? [release, version] : [release]));
  const url = (manifest) => manifest.baseUrl || `${manifest.publicBaseUrl}okd/${manifest.profileId}/${manifest.versionId}/`;
  async function finalizeArtifacts({ workspace, profile, job, mode = profile.boot_mode, publicBaseUrl = profile.asset_url }) {
    return serialize(async () => {
      assert(profile.id, SLUG, 'profile'); assert(profile.release, RELEASE, 'release'); assert(job.mediaVersion, VERSION, 'media version');
      if (!SHA256.test(profile.revision || '') || !SHA256.test(job.installerArchiveSha256 || '') || !SHA256.test(job.installerBinarySha256 || '')) throw coded('Artifact provenance is invalid.', 'ARTIFACT_INVALID');
      const names = outputs(record, mode); const sourceRoot = mode === 'pxe' ? path.join(path.resolve(workspace), 'boot-artifacts') : path.resolve(workspace); await directory(sourceRoot);
      await safeDirectory(assetsRoot, dir(profile.id, profile.release), 0o755);
      const target = dir(profile.id, profile.release, job.mediaVersion); if (await lstat(target)) throw coded('Artifact version already exists.', 'VERSION_EXISTS');
      const staging = path.join(dir(profile.id, profile.release), `.${job.mediaVersion}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`); await fs.promises.mkdir(staging, { mode: 0o700 });
      try {
        const baseUrl = mode === 'pxe' ? `${validateOrigin(publicBaseUrl)}okd/${profile.id}/${profile.release}/${job.mediaVersion}/` : null; const files = [];
        for (const role of Object.keys(names)) if (role !== 'ipxe') { const source = path.resolve(sourceRoot, names[role]); if (path.dirname(source) !== sourceRoot) throw coded('Artifact path is unsafe.', 'UNSAFE_PATH'); files.push({ role, name: names[role], ...(await copy(source, path.join(staging, names[role]))) }); }
        if (mode === 'pxe') {
          const source = path.resolve(sourceRoot, names.ipxe); const opened = await require('./safeFile').openRegular(source); let text;
          try { if (!opened.stat.size || opened.stat.size > 1024 * 1024) throw coded('Installer iPXE output is invalid.', 'ARTIFACT_INVALID'); text = await opened.handle.readFile('utf8'); } finally { await opened.handle.close(); }
          const content = Buffer.from(rewriteBootScript(text, names, baseUrl)); await fs.promises.writeFile(path.join(staging, 'boot.ipxe'), content, { flag: 'wx', mode: 0o644 }); files.push({ role: 'ipxe', name: 'boot.ipxe', size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        const manifest = { schemaVersion: 2, profileId: profile.id, profileRevision: profile.revision, release: profile.release, mediaVersion: job.mediaVersion, versionId: job.mediaVersion, mode,
          releaseImage: record.releaseImage, releaseDigest: record.releaseDigest, compatibilityRevision: record.revision, installer: { archiveSha256: job.installerArchiveSha256, binarySha256: job.installerBinarySha256 },
          productionOrigin: baseUrl ? validateOrigin(publicBaseUrl) : null, baseUrl, files, createdAt: now() };
        await fs.promises.writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
        await fs.promises.writeFile(path.join(staging, 'SHA256SUMS'), `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`, { flag: 'wx', mode: 0o644 });
        await fs.promises.chmod(staging, 0o755); await fs.promises.rename(staging, target); return publicVersion(manifest, false);
      } catch (err) { await fs.promises.rm(staging, { recursive: true, force: true }); if (['ENOENT', 'ELOOP'].includes(err.code)) throw coded('Expected installer artifact is missing or unsafe.', 'ARTIFACT_INVALID'); throw err; }
    });
  }
  function validNew(m, profile, release, version) {
    if (!m || m.schemaVersion !== 2 || m.profileId !== profile || m.release !== release || m.mediaVersion !== version || m.versionId !== version || !['pxe', 'iso'].includes(m.mode)
      || !SHA256.test(m.profileRevision || '') || !Array.isArray(m.files) || m.files.some((f) => !f || !/^[A-Za-z0-9._-]+$/.test(f.name || '') || !SHA256.test(f.sha256 || '') || !Number.isSafeInteger(f.size) || f.size < 1)) return false;
    const keys = ['baseUrl', 'compatibilityRevision', 'createdAt', 'files', 'installer', 'mediaVersion', 'mode', 'productionOrigin', 'profileId', 'profileRevision', 'release', 'releaseDigest', 'releaseImage', 'schemaVersion', 'versionId'];
    if (Object.keys(m).sort().join('\0') !== keys.sort().join('\0') || !Number.isFinite(Date.parse(m.createdAt))
      || m.releaseImage !== record.releaseImage || m.releaseDigest !== record.releaseDigest || m.compatibilityRevision !== record.revision
      || !m.installer || Object.keys(m.installer).sort().join('\0') !== 'archiveSha256\0binarySha256'
      || !SHA256.test(m.installer.archiveSha256 || '') || !SHA256.test(m.installer.binarySha256 || '')
      || m.files.some((file) => Object.keys(file).sort().join('\0') !== 'name\0role\0sha256\0size')) return false;
    const names = outputs(record, m.mode); const expected = Object.entries(names).map(([role, name]) => ({ role, name: role === 'ipxe' ? 'boot.ipxe' : name }));
    if (m.files.length !== expected.length || expected.some((item) => !m.files.some((file) => file.role === item.role && file.name === item.name))
      || new Set(m.files.map((file) => file.name)).size !== m.files.length || new Set(m.files.map((file) => file.role)).size !== m.files.length) return false;
    if (m.mode === 'pxe') { try { if (m.productionOrigin !== validateOrigin(m.productionOrigin) || m.baseUrl !== `${m.productionOrigin}okd/${profile}/${release}/${version}/`) return false; } catch { return false; } }
    return m.mode !== 'iso' || (m.productionOrigin === null && m.baseUrl === null);
  }
  function validLegacy(m, profile, version) { return m && m.schemaVersion === 1 && m.profileId === profile && m.versionId === version && m.jobId === version && LEGACY.test(version) && Array.isArray(m.files); }
  async function readVersion(profile, release, version) {
    assert(profile, SLUG, 'profile'); const legacy = version === undefined; if (legacy) { version = release; assert(version, LEGACY, 'legacy version'); } else { assert(release, RELEASE, 'release'); assert(version, VERSION, 'media version'); }
    const target = legacy ? dir(profile, version) : dir(profile, release, version); await safeDirectory(root, target);
    let manifest; try { manifest = JSON.parse(await require('./safeFile').readBounded(path.join(target, 'manifest.json'), 1024 * 1024)); } catch { throw coded('Artifact manifest is invalid.', 'INVALID_MANIFEST'); }
    if (!(legacy ? validLegacy(manifest, profile, version) : validNew(manifest, profile, release, version))) throw coded('Artifact manifest is invalid.', 'INVALID_MANIFEST');
    const expected = ['manifest.json', ...manifest.files.map((f) => f.name), ...(legacy ? [] : ['SHA256SUMS'])].sort(); if ((await fs.promises.readdir(target)).sort().join('\0') !== expected.join('\0')) throw coded('Artifact version contains unexpected files.', 'INVALID_MANIFEST');
    for (const entry of manifest.files) { const actual = await hashFile(path.join(target, entry.name)); if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw coded('Artifact checksum mismatch.', 'INVALID_MANIFEST'); }
    if (!legacy) {
      const sums = `${manifest.files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`;
      if (await require('./safeFile').readBounded(path.join(target, 'SHA256SUMS'), 1024 * 1024) !== sums) throw coded('Artifact checksums are invalid.', 'INVALID_MANIFEST');
    }
    return manifest;
  }
  async function pointer(profile) { await safeDirectory(configRoot, publications, 0o700); const file = path.join(publications, `${profile}.json`); const stat = await lstat(file); if (!stat) return null; let value; try { value = JSON.parse(await require('./safeFile').readBounded(file, 64 * 1024)); } catch { throw coded('Publication pointer is invalid.', 'INVALID_PUBLICATION'); } if (value.profileId !== profile || (!VERSION.test(value.versionId || '') && !LEGACY.test(value.versionId || ''))) throw coded('Publication pointer is invalid.', 'INVALID_PUBLICATION'); return value; }
  function publicVersion(manifest, active) {
    return {
      schemaVersion: manifest.schemaVersion, profileId: manifest.profileId, profileRevision: manifest.profileRevision,
      release: manifest.release, mediaVersion: manifest.mediaVersion || manifest.versionId, versionId: manifest.versionId,
      mode: manifest.mode, releaseImage: manifest.releaseImage, releaseDigest: manifest.releaseDigest,
      compatibilityRevision: manifest.compatibilityRevision, installer: manifest.installer, productionOrigin: manifest.productionOrigin || null,
      baseUrl: manifest.baseUrl || null, ...(manifest.schemaVersion === 1 ? { publicBaseUrl: manifest.publicBaseUrl } : {}),
      files: manifest.files.map((file) => ({ role: file.role, name: file.name, size: file.size, sha256: file.sha256 })),
      createdAt: manifest.createdAt, active, isoUrl: null, ...(manifest.schemaVersion === 1 ? { legacy: true } : {}),
    };
  }
  async function listVersions(profile) {
    assert(profile, SLUG, 'profile'); const base = path.join(root, profile); const stat = await lstat(base); if (!stat) return []; await directory(base); const active = await pointer(profile); const result = [];
    for (const name of await fs.promises.readdir(base)) {
      if (LEGACY.test(name)) { try { result.push(publicVersion(await readVersion(profile, name), !!active && active.versionId === name)); } catch { /* legacy invalid */ } continue; }
      if (!RELEASE.test(name)) continue; const releaseDir = path.join(base, name); const releaseStat = await lstat(releaseDir); if (!releaseStat || releaseStat.isSymbolicLink() || !releaseStat.isDirectory()) continue;
      for (const version of await fs.promises.readdir(releaseDir)) if (VERSION.test(version)) try { result.push(publicVersion(await readVersion(profile, name, version), !!active && active.release === name && active.versionId === version)); } catch { /* invalid version omitted */ }
    }
    return result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async function listAssets() { const stat = await lstat(root); if (!stat) return []; await directory(root); const result = []; for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) if (entry.isDirectory() && SLUG.test(entry.name)) for (const version of await listVersions(entry.name)) result.push({ profileId: version.profileId, release: version.release, versionId: version.versionId, mediaVersion: version.mediaVersion, mode: version.mode, active: version.active, createdAt: version.createdAt, files: version.files.map((file) => ({ role: file.role, name: file.name, url: version.mode === 'pxe' ? `${url(version)}${file.name}` : null, ...(version.mode === 'iso' ? { portalPath: version.legacy ? `/okd/${version.profileId}/${version.versionId}/iso` : `/okd/${version.profileId}/${version.release}/${version.versionId}/iso` } : {}) })) }); return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async function openIso(profile, release, version) { let opened; try { const mediaVersion = version || release; const manifest = await readVersion(profile, release, version); if (manifest.mode !== 'iso') throw new Error(); const entry = manifest.files.find((f) => f.role === 'iso'); const target = manifest.schemaVersion === 1 ? dir(profile, mediaVersion) : dir(profile, release, mediaVersion); opened = await require('./safeFile').openRegular(path.join(target, entry.name)); if (opened.stat.size !== entry.size) throw new Error(); return { handle: opened.handle, size: entry.size, name: `${profile}-${manifest.release}-${mediaVersion}.iso` }; } catch { if (opened) await opened.handle.close().catch(() => {}); throw coded('ISO not found.', 'NOT_FOUND'); } }
  async function openPxeBundle(profile, release, version) {
    const manifest = await readVersion(profile, release, version); if (manifest.schemaVersion !== 2 || manifest.mode !== 'pxe') throw coded('PXE bundle not found.', 'NOT_FOUND'); const target = dir(profile, release, version);
    const members = [...manifest.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })), { name: 'manifest.json', ...(await hashFile(path.join(target, 'manifest.json'))) }, { name: 'SHA256SUMS', ...(await hashFile(path.join(target, 'SHA256SUMS'))) }];
    async function* tar() { const prefix = `okd/${profile}/${release}/${version}/`; for (const member of members) { yield tarHeader(prefix + member.name, member.size); const opened = await require('./safeFile').openRegular(path.join(target, member.name)); const hash = crypto.createHash('sha256'); let size = 0; try { for await (const chunk of opened.handle.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk); yield chunk; } const after = await opened.handle.stat(); if (size !== member.size || hash.digest('hex') !== member.sha256 || after.size !== opened.stat.size || after.mtimeMs !== opened.stat.mtimeMs || after.ctimeMs !== opened.stat.ctimeMs) throw coded('Artifact changed during export.', 'INVALID_MANIFEST'); } finally { await opened.handle.close(); } const padding = (512 - member.size % 512) % 512; if (padding) yield Buffer.alloc(padding); } yield Buffer.alloc(1024); }
    const source = Readable.from(tar()); const gzip = zlib.createGzip({ level: 6 }); source.on('error', (err) => gzip.destroy(err)); source.pipe(gzip);
    return { stream: gzip, name: `${profile}-${release}-${version}.tar.gz`, manifest };
  }
  async function atomic(file, value) { const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`; try { await fs.promises.writeFile(temp, value, { flag: 'wx', mode: 0o600 }); await fs.promises.rename(temp, file); } finally { await fs.promises.rm(temp, { force: true }); } }
  async function regenerateMenu() { await safeDirectory(configRoot, menuRoot, 0o755); await safeDirectory(configRoot, publications, 0o700); const lines = ['#!ipxe', 'menu OKD Agent PXE']; const selected = []; for (const name of await fs.promises.readdir(publications)) if (/^[a-z0-9-]+\.json$/.test(name)) { const profile = name.slice(0, -5); const p = await pointer(profile); const m = p.release ? await readVersion(profile, p.release, p.versionId) : await readVersion(profile, p.versionId); if (m.mode === 'pxe') selected.push({ p, m }); } if (!selected.length) { await fs.promises.rm(menuFile, { force: true }); return; } for (const { p } of selected) lines.push(`item okd-${p.profileId} ${p.profileId}`); lines.push('choose okd_target || exit', 'goto ${okd_target}'); for (const { p, m } of selected) lines.push(`:okd-${p.profileId}`, `chain ${url(m)}boot.ipxe || exit`); const content = `${lines.join('\n')}\n`; await writeMenu(menuFile, content, () => fs.promises.writeFile(menuFile, content, { mode: 0o644 })); }
  async function publish(profile, release, version) { return serialize(async () => { const manifest = version ? await readVersion(profile, release, version) : await readVersion(profile, release); if (manifest.mode !== 'pxe') throw coded('ISO versions cannot be published.', 'ISO_NOT_PUBLISHABLE'); await safeDirectory(configRoot, publications, 0o700); const file = path.join(publications, `${profile}.json`); const previous = await lstat(file) ? await require('./safeFile').readBounded(file, 64 * 1024) : null; const value = { profileId: profile, ...(version ? { release } : {}), versionId: version || release, activatedAt: now() }; await atomic(file, `${JSON.stringify(value, null, 2)}\n`); try { await regenerateMenu(); } catch (err) { if (previous === null) await fs.promises.rm(file, { force: true }); else await atomic(file, previous); throw err; } return publicVersion(manifest, true); }); }
  async function unpublish(profile) { return serialize(async () => { assert(profile, SLUG, 'profile'); await safeDirectory(configRoot, publications, 0o700); const file = path.join(publications, `${profile}.json`); const previous = await lstat(file) ? await require('./safeFile').readBounded(file, 64 * 1024) : null; await fs.promises.rm(file, { force: true }); try { await regenerateMenu(); } catch (err) { if (previous !== null) await atomic(file, previous); throw err; } return { profileId: profile, active: false }; }); }
  async function deleteVersion(profile, release, version, confirmed) { return serialize(async () => { if (confirmed !== true) throw coded('Confirm deletion.', 'CONFIRMATION_REQUIRED'); const active = await pointer(profile); const id = version || release; if (active && active.versionId === id) throw coded('Unpublish this version first.', 'VERSION_ACTIVE'); await readVersion(profile, release, version); await fs.promises.rm(version ? dir(profile, release, version) : dir(profile, release), { recursive: true }); return { profileId: profile, release: version ? release : undefined, versionId: id }; }); }
  const reconcilePublications = () => serialize(regenerateMenu);
  return { finalizeArtifacts, readVersion, listVersions, listAssets, openIso, openPxeBundle, publish, unpublish, deleteVersion, regenerateMenu, reconcilePublications };
}
const service = createArtifactService();
module.exports = { createArtifactService, rewriteBootScript, finalizeArtifacts: service.finalizeArtifacts, listVersions: service.listVersions, listAssets: service.listAssets, openIso: service.openIso, openPxeBundle: service.openPxeBundle, publishVersion: service.publish, unpublishProfile: service.unpublish, deleteVersion: service.deleteVersion, reconcilePublications: service.reconcilePublications };
