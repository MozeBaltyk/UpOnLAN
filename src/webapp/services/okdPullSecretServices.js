'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_EXTERNAL_FILE = '/run/secrets/okd-pull-secret';
const PUBLIC_PULL_SECRET = '{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}';
const MAX_BYTES = 1024 * 1024;

function coded(message, code) { return Object.assign(new Error(message), { code }); }
async function lstat(target) {
  try { return await fs.promises.lstat(target); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function validate(raw) {
  if (typeof raw !== 'string' || !raw.length || Buffer.byteLength(raw) > MAX_BYTES) throw coded('Pull secret must be nonempty JSON no larger than 1 MiB.', 'PULL_SECRET_INVALID');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw coded('Pull secret is not valid JSON. Paste the JSON object directly without surrounding shell-style quotes, for example: {"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}.', 'PULL_SECRET_INVALID'); }
  if (typeof parsed === 'string') throw coded('Pull secret must be a JSON object, not quoted JSON. Paste the JSON object directly without surrounding quotes.', 'PULL_SECRET_INVALID');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.auths || typeof parsed.auths !== 'object' || Array.isArray(parsed.auths)
    || !Object.keys(parsed.auths).length || Object.values(parsed.auths).some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
      || ![entry.auth, entry.identitytoken].some((credential) => typeof credential === 'string' && credential.length))) {
    throw coded('Pull secret must contain a nonempty auths object with a credential for every entry.', 'PULL_SECRET_INVALID');
  }
  return parsed;
}

function createPullSecretService({
  configRoot = process.env.UPONLAN_CONFIG || '/config',
  externalFile = process.env.OKD_PULL_SECRET_FILE || DEFAULT_EXTERNAL_FILE,
  externalConfigured = Object.hasOwn(process.env, 'OKD_PULL_SECRET_FILE'),
  authConfigured = () => !!(process.env.WEBAPP_USER && process.env.WEBAPP_PASS),
  persistenceReady = process.env.OKD_PERSISTENCE_READY === 'true',
  renameFile = fs.promises.rename,
} = {}) {
  const secretsDir = path.join(configRoot, 'okd', 'secrets');
  const internalFile = path.join(secretsDir, 'pull-secret');

  async function readFile(file, source) {
    let handle;
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw coded('Pull secret path is unsafe.', 'UNSAFE_PATH');
      const raw = await handle.readFile('utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES) throw coded('Pull secret is too large.', 'PULL_SECRET_INVALID');
      return { raw, parsed: validate(raw), source };
    } catch (err) {
      if (err.code === 'ELOOP') throw coded('Pull secret path is unsafe.', 'UNSAFE_PATH');
      throw err;
    } finally { if (handle) await handle.close(); }
  }

  async function resolve() {
    let externalStat;
    try { externalStat = await lstat(externalFile); }
    catch { throw coded('The external pull secret is unavailable.', 'PULL_SECRET_UNAVAILABLE'); }
    if (externalConfigured || externalStat) {
      if (!externalStat) throw coded('The configured external pull secret is unavailable.', 'PULL_SECRET_UNAVAILABLE');
      if (externalStat.isSymbolicLink() || !externalStat.isFile() || externalStat.nlink !== 1) throw coded('The external pull secret path is unsafe.', 'UNSAFE_PATH');
      try { return await readFile(externalFile, 'external'); }
      catch (err) {
        if (['PULL_SECRET_INVALID', 'UNSAFE_PATH'].includes(err.code)) throw err;
        throw coded('The external pull secret is unavailable.', 'PULL_SECRET_UNAVAILABLE');
      }
    }
    const internalStat = await lstat(internalFile);
    if (!internalStat) return { raw: PUBLIC_PULL_SECRET, parsed: validate(PUBLIC_PULL_SECRET), source: 'default' };
    if (internalStat.isSymbolicLink() || !internalStat.isFile() || internalStat.nlink !== 1) throw coded('The internal pull secret path is unsafe.', 'UNSAFE_PATH');
    return readFile(internalFile, 'internal');
  }

  async function status() {
    const disabledReasons = (source) => source === 'external'
      ? ['External secret is authoritative and read-only; update the mount and restart for rotation.']
      : [!persistenceReady && 'Configure persistent config storage.'].filter(Boolean);
    const authenticationConfigured = authConfigured();
    let externalStat;
    try { externalStat = await lstat(externalFile); }
    catch { return { status: 'invalid', source: 'external', exists: true, writable: false, authenticationConfigured, disabledReasons: disabledReasons('external') }; }
    const expectedSource = externalConfigured || externalStat ? 'external' : 'internal';
    try {
      const value = await resolve();
      return { status: 'ready', source: value.source, exists: value.source !== 'default', writable: value.source !== 'external' && persistenceReady, authenticationConfigured, disabledReasons: disabledReasons(value.source) };
    } catch (err) {
      const internalStat = expectedSource === 'internal' ? await lstat(internalFile).catch(() => false) : null;
      const exists = expectedSource === 'external' ? !!externalStat : !!internalStat;
      return { status: err.code === 'PULL_SECRET_UNAVAILABLE' && !exists && expectedSource === 'internal' ? 'missing' : 'invalid', source: expectedSource, exists, writable: expectedSource === 'internal' && persistenceReady, authenticationConfigured, disabledReasons: disabledReasons(expectedSource) };
    }
  }

  async function secureDirectory() {
    const root = path.resolve(configRoot);
    let current = root;
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    for (const part of ['okd', 'secrets']) {
      const stat = await lstat(current);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw coded('Pull secret storage path is unsafe.', 'UNSAFE_PATH');
      current = path.join(current, part);
      await fs.promises.mkdir(current, { mode: 0o700 }).catch((err) => { if (err.code !== 'EEXIST') throw err; });
    }
    const stat = await lstat(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw coded('Pull secret storage path is unsafe.', 'UNSAFE_PATH');
    await fs.promises.chmod(current, 0o700);
  }

  async function save(raw) {
    if (!persistenceReady) throw coded('Persistent config storage is required to manage an internal pull secret.', 'PERSISTENCE_REQUIRED');
    if (externalConfigured || await lstat(externalFile)) throw coded('The pull secret is externally managed and read-only.', 'EXTERNALLY_MANAGED');
    validate(raw);
    await secureDirectory();
    const existing = await lstat(internalFile);
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) throw coded('The internal pull secret path is unsafe.', 'UNSAFE_PATH');
    const temp = path.join(secretsDir, `.pull-secret.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await fs.promises.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close(); handle = null;
      if (externalConfigured || await lstat(externalFile)) throw coded('The pull secret is externally managed and read-only.', 'EXTERNALLY_MANAGED');
      const current = await lstat(internalFile);
      if (current && (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1)) throw coded('The internal pull secret path is unsafe.', 'UNSAFE_PATH');
      await renameFile(temp, internalFile);
      const dir = await fs.promises.open(secretsDir, fs.constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
      return { status: 'ready', source: 'internal', exists: true, writable: true, authenticationConfigured: authConfigured(), disabledReasons: [] };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }

  return { resolve, status, save };
}

const service = createPullSecretService();
module.exports = { PUBLIC_PULL_SECRET, createPullSecretService, validate, resolve: service.resolve, status: service.status, save: service.save };
