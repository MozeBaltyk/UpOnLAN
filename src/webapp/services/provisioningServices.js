'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yaml = require('js-yaml');
const { execFile } = require('child_process');

const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
const ASSETS_ROOT = process.env.UPONLAN_ASSETS || '/assets';
const PROVISIONING_ROOT = path.resolve(CONFIG_ROOT, 'provisioning', 'local');
const PROVISIONING_ASSETS_ROOT = path.resolve(ASSETS_ROOT, 'provisioning');
const ALLOWED_FILES = new Set(['ks.cfg', 'user-data', 'meta-data', 'network-config']);
// Per-profile metadata sidecar (version string). Deliberately NOT in ALLOWED_FILES,
// so it never shows up as an editable file in the sidebar.
const PROFILE_VERSION_FILE = 'version';

function toRelativePath(root, fullPath) {
  return path.relative(root, fullPath).split(path.sep).join('/');
}

function isPathInsideRoot(root, fullPath) {
  const rel = path.relative(root, fullPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveAllowedProvisioningFile(root, relativePath) {
  const fullPath = path.resolve(root, String(relativePath || ''));
  const safeRelativePath = toRelativePath(root, fullPath);
  if (!relativePath || !safeRelativePath || !isPathInsideRoot(root, fullPath) || !ALLOWED_FILES.has(path.basename(fullPath))) {
    throw new Error('Invalid provisioning path');
  }
  return { fullPath, relativePath: safeRelativePath };
}

function resolveProvisioningFile(relativePath) {
  return resolveAllowedProvisioningFile(PROVISIONING_ROOT, relativePath);
}

function resolvePublishedProvisioningFile(relativePath) {
  return resolveAllowedProvisioningFile(PROVISIONING_ASSETS_ROOT, relativePath);
}

function resolveProvisioningProfile(profilePath) {
  const fullPath = path.resolve(PROVISIONING_ROOT, String(profilePath || ''));
  const safeRelativePath = toRelativePath(PROVISIONING_ROOT, fullPath);
  if (!profilePath || !safeRelativePath || !isPathInsideRoot(PROVISIONING_ROOT, fullPath) || ALLOWED_FILES.has(path.basename(fullPath))) {
    throw new Error('Invalid provisioning path');
  }
  return { fullPath, relativePath: safeRelativePath };
}

// The version sidecar lives in the profile directory (dirname of a file path),
// so one profile's ks.cfg / user-data / meta-data share a single version string.
function resolveProfileVersionPath(relativePath) {
  const { relativePath: safeRelativePath } = resolveProvisioningFile(relativePath);
  const profileDir = path.posix.dirname(safeRelativePath);
  const profile = resolveProvisioningProfile(profileDir);
  return path.join(profile.fullPath, PROFILE_VERSION_FILE);
}

async function getProvisioningVersion(relativePath) {
  const versionPath = resolveProfileVersionPath(relativePath);
  try {
    return (await fsp.readFile(versionPath, 'utf8')).trim();
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function setProvisioningVersion(relativePath, version) {
  const versionPath = resolveProfileVersionPath(relativePath);
  const trimmed = String(version || '').trim();
  if (!trimmed) {
    try { await fsp.unlink(versionPath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return '';
  }
  await fsp.mkdir(path.dirname(versionPath), { recursive: true });
  await fsp.writeFile(versionPath, trimmed + '\n', 'utf8');
  return trimmed;
}

// Run a validator binary; resolve with { ok, notFound, output } so callers can
// degrade gracefully when the tool isn't installed.
function runValidator(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, notFound: err.code === 'ENOENT', output: (stderr || err.message || '').trim() });
        return;
      }
      resolve({ ok: true, notFound: false, output: (stdout || '').trim() });
    });
  });
}

async function validateProvisioningFile(relativePath, version) {
  const { fullPath } = await ensureProvisioningFile(relativePath);
  const base = path.basename(fullPath);

  // Kickstart: ksvalidator from pykickstart. No Alpine 3.24 package exists, so
  // report a clear message instead of a confusing crash when it is absent.
  if (base === 'ks.cfg') {
    const args = version ? ['-v', version, fullPath] : [fullPath];
    const res = await runValidator('ksvalidator', args);
    if (res.notFound) {
      return { ok: false, message: 'ksvalidator is not installed (no pykickstart package for Alpine 3.24).' };
    }
    return res.ok
      ? { ok: true, message: 'Kickstart syntax OK' }
      : { ok: false, message: res.output || 'Kickstart validation failed' };
  }

  // cloud-init user-data: schema check via the cloud-init CLI.
  if (base === 'user-data') {
    const res = await runValidator('cloud-init', ['schema', '--config-file', fullPath]);
    if (res.notFound) {
      return { ok: false, message: 'cloud-init is not installed in the container.' };
    }
    return res.ok
      ? { ok: true, message: 'cloud-init schema OK' }
      : { ok: false, message: res.output || 'cloud-init schema validation failed' };
  }

  // meta-data / network-config: cheap YAML syntax check (js-yaml already present).
  try {
    const content = await fsp.readFile(fullPath, 'utf8');
    yaml.load(content);
    return { ok: true, message: 'YAML syntax OK' };
  } catch (err) {
    return { ok: false, message: `YAML syntax error: ${err.message}` };
  }
}

async function walkProvisioningFiles(root, dir = root, files = []) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return files;
    throw err;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkProvisioningFiles(root, fullPath, files);
    } else if (ALLOWED_FILES.has(entry.name)) {
      files.push(toRelativePath(root, fullPath));
    }
  }
  return files;
}

async function ensureProvisioningFile(relativePath) {
  const localFile = resolveProvisioningFile(relativePath);
  try {
    await fsp.access(localFile.fullPath, fs.constants.F_OK);
    return localFile;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const assetFile = resolvePublishedProvisioningFile(relativePath);
  await fsp.mkdir(path.dirname(localFile.fullPath), { recursive: true });
  await fsp.copyFile(assetFile.fullPath, localFile.fullPath);
  return localFile;
}

function getProvisioningKind(relativePath) {
  return relativePath.startsWith('kickstart/') || path.posix.basename(relativePath) === 'ks.cfg'
    ? 'Kickstart'
    : 'Cloud-init';
}

async function publishProvisioningFile(relativePath) {
  const { fullPath, relativePath: safeRelativePath } = resolveProvisioningFile(relativePath);
  const assetPath = path.resolve(PROVISIONING_ASSETS_ROOT, safeRelativePath);
  await fsp.mkdir(path.dirname(assetPath), { recursive: true });
  await fsp.copyFile(fullPath, assetPath);
}

async function listProvisioningFiles() {
  await fsp.mkdir(PROVISIONING_ROOT, { recursive: true });
  return walkProvisioningFiles(PROVISIONING_ROOT);
}

async function listProvisioningAssets() {
  await fsp.mkdir(PROVISIONING_ASSETS_ROOT, { recursive: true });
  const files = await walkProvisioningFiles(PROVISIONING_ASSETS_ROOT);
  const versionCache = new Map();
  const rows = [];
  for (const relativePath of files) {
    const profile = path.posix.dirname(relativePath);
    if (!versionCache.has(profile)) {
      versionCache.set(profile, await getProvisioningVersion(relativePath));
    }
    rows.push({
      relativePath,
      category: 'Provisioning',
      kind: getProvisioningKind(relativePath),
      profile,
      file: path.posix.basename(relativePath),
      version: versionCache.get(profile),
      urlPath: `/provisioning/${relativePath}`,
    });
  }
  return rows;
}

async function readProvisioningFile(relativePath) {
  const { fullPath } = await ensureProvisioningFile(relativePath);
  return fsp.readFile(fullPath, 'utf8');
}

async function saveProvisioningFile(relativePath, text) {
  const { fullPath, relativePath: safeRelativePath } = resolveProvisioningFile(relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, text, 'utf8');
  await publishProvisioningFile(safeRelativePath);
  return safeRelativePath;
}

async function pruneEmptyDirectories(dir, root) {
  let current = dir;
  while (current && current !== root) {
    const rel = path.relative(root, current);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      await fsp.rmdir(current);
    } catch (err) {
      if (err.code === 'ENOTEMPTY' || err.code === 'ENOENT') return;
      throw err;
    }
    current = path.dirname(current);
  }
}

async function deleteProvisioningFile(relativePath) {
  const { fullPath, relativePath: safeRelativePath } = resolveProvisioningFile(relativePath);
  const assetPath = path.resolve(PROVISIONING_ASSETS_ROOT, safeRelativePath);

  await fsp.unlink(fullPath);
  await pruneEmptyDirectories(path.dirname(fullPath), PROVISIONING_ROOT);

  try {
    await fsp.unlink(assetPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await pruneEmptyDirectories(path.dirname(assetPath), PROVISIONING_ASSETS_ROOT);

  return safeRelativePath;
}

async function createKickstartProfile(profilePath) {
  const { fullPath, relativePath } = resolveProvisioningProfile(profilePath);
  await fsp.mkdir(fullPath, { recursive: true });
  const filePath = path.posix.join(relativePath, 'ks.cfg');
  await saveProvisioningFile(filePath, '# kickstart\n');
  return [filePath];
}

async function createCloudInitProfile(profilePath) {
  const { fullPath, relativePath } = resolveProvisioningProfile(profilePath);
  const name = path.basename(fullPath);
  await fsp.mkdir(fullPath, { recursive: true });
  const userDataPath = path.posix.join(relativePath, 'user-data');
  const metaDataPath = path.posix.join(relativePath, 'meta-data');
  // A valid YAML dict from the start, so `cloud-init schema` passes out of the
  // box (a comment-only file parses as null, which cloud-init rejects).
  await saveProvisioningFile(userDataPath, '#cloud-config\nusers:\n  - name: ubuntu\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n');
  await saveProvisioningFile(metaDataPath, `instance-id: ${name}\nlocal-hostname: ${name}\n`);
  return [userDataPath, metaDataPath];
}

module.exports = {
  listProvisioningFiles,
  listProvisioningAssets,
  readProvisioningFile,
  saveProvisioningFile,
  deleteProvisioningFile,
  createKickstartProfile,
  createCloudInitProfile,
  getProvisioningVersion,
  setProvisioningVersion,
  validateProvisioningFile,
};
