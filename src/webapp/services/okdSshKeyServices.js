'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function coded(message, code) { return Object.assign(new Error(message), { code }); }

function validSshPublicKey(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 || value.includes('\n') || value.includes('\r')) return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length < 2 || !/^(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-nistp(?:256|384|521))$/.test(fields[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1])) return false;
  let blob;
  try { blob = Buffer.from(fields[1], 'base64'); } catch { return false; }
  const canonicalBase64 = blob.toString('base64');
  if (fields[1] !== canonicalBase64 && fields[1] !== canonicalBase64.replace(/=+$/, '')) return false;
  let offset = 0;
  const field = () => {
    if (offset + 4 > blob.length) throw new Error('short SSH field');
    const length = blob.readUInt32BE(offset); offset += 4;
    if (length > blob.length - offset) throw new Error('short SSH field');
    const result = blob.subarray(offset, offset + length); offset += length;
    return result;
  };
  const base64url = (data) => data.toString('base64url');
  const positiveMpint = (data) => {
    if (!data.length || (data[0] & 0x80) || (data[0] === 0 && (data.length === 1 || !(data[1] & 0x80)))) return null;
    return data[0] === 0 ? data.subarray(1) : data;
  };
  try {
    if (field().toString() !== fields[0]) return false;
    if (fields[0] === 'ssh-ed25519') {
      const key = field();
      if (key.length !== 32 || offset !== blob.length) return false;
      return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64url(key) }, format: 'jwk' }).asymmetricKeyType === 'ed25519';
    }
    if (fields[0] === 'ssh-rsa') {
      const exponent = positiveMpint(field()); const modulus = positiveMpint(field());
      if (!exponent || !modulus || offset !== blob.length || modulus.length < 128 || !(modulus.at(-1) & 1)) return false;
      const e = BigInt(`0x${exponent.toString('hex')}`);
      if (e < 3n || !(e & 1n)) return false;
      const key = crypto.createPublicKey({ key: { kty: 'RSA', n: base64url(modulus), e: base64url(exponent) }, format: 'jwk' });
      return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 1024;
    }
    const curves = {
      nistp256: { jwk: 'P-256', coordinate: 32 }, nistp384: { jwk: 'P-384', coordinate: 48 }, nistp521: { jwk: 'P-521', coordinate: 66 },
    };
    const curveName = field().toString(); const point = field(); const curve = curves[curveName];
    if (!curve || fields[0] !== `ecdsa-sha2-${curveName}` || offset !== blob.length || point.length !== 1 + 2 * curve.coordinate || point[0] !== 4) return false;
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: curve.jwk,
      x: base64url(point.subarray(1, 1 + curve.coordinate)), y: base64url(point.subarray(1 + curve.coordinate)) }, format: 'jwk' });
    return key.asymmetricKeyType === 'ec';
  } catch { return false; }
}

function keygenEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function runSshKeygen(args) {
  return new Promise((resolve, reject) => execFile('/usr/bin/ssh-keygen', args, {
    env: keygenEnv(), timeout: 30000, maxBuffer: 64 * 1024,
  }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}

function createSshKeyService({
  configRoot = process.env.UPONLAN_CONFIG || '/config',
  runKeyCommand = runSshKeygen,
  renameKeyDirectory = fs.promises.rename,
} = {}) {
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const fdPath = (handle, name = '') => path.join(`/proc/${process.pid}/fd/${handle.fd}`, name);

  async function openAbsoluteDirectory(target) {
    let current = await fs.promises.open('/', directoryFlags);
    try {
      for (const part of path.resolve(target).split(path.sep).filter(Boolean)) {
        const next = await fs.promises.open(fdPath(current, part), directoryFlags);
        await current.close(); current = next;
      }
      return current;
    } catch (err) { await current.close().catch(() => {}); throw err; }
  }

  async function openChildDirectory(parent, name, secureExisting = false, requireNew = false) {
    const target = fdPath(parent, name); let created = false;
    try { await fs.promises.mkdir(target, { mode: 0o700 }); created = true; } catch (err) { if (err.code !== 'EEXIST' || requireNew) throw err; }
    let child;
    try {
      child = await fs.promises.open(target, directoryFlags);
      const stat = await child.stat();
      if (!stat.isDirectory()) throw coded('OKD key storage path is unsafe.', 'UNSAFE_PATH');
      if (created || secureExisting) await child.chmod(0o700);
      return child;
    } catch (err) { if (child) await child.close().catch(() => {}); throw err; }
  }

  async function openKeysRoot() {
    const config = await openAbsoluteDirectory(configRoot); let okd;
    try {
      okd = await openChildDirectory(config, 'okd');
      return await openChildDirectory(okd, 'keys', true);
    } finally {
      if (okd) await okd.close().catch(() => {});
      await config.close().catch(() => {});
    }
  }

  async function checkedKeyFile(dir, name, mode, read = false) {
    let handle;
    try {
      handle = await fs.promises.open(fdPath(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 64 * 1024) throw coded('Stored SSH keypair is unsafe.', 'UNSAFE_PATH');
      await handle.chmod(mode);
      return read ? (await handle.readFile('utf8')).trim() : null;
    } catch (err) {
      if (err.code === 'ELOOP') throw coded('Stored SSH keypair is unsafe.', 'UNSAFE_PATH');
      if (err.code === 'ENOENT') throw coded('Stored SSH keypair is incomplete or unsafe.', 'UNSAFE_PATH');
      throw err;
    } finally { if (handle) await handle.close(); }
  }

  async function validateOpenedKeyDirectory(dir) {
    const stat = await dir.stat();
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022)) throw coded('Stored SSH keypair directory is unsafe.', 'UNSAFE_PATH');
    const publicText = await checkedKeyFile(dir, 'id_ed25519.pub', 0o644, true);
    await checkedKeyFile(dir, 'id_ed25519', 0o600);
    if (!validSshPublicKey(publicText)) throw coded('Stored SSH public key is invalid.', 'SSH_KEY_INVALID');
    let derived;
    try { derived = String(await runKeyCommand(['-y', '-f', fdPath(dir, 'id_ed25519')])).trim(); } catch { throw coded('Stored SSH keypair could not be verified.', 'SSH_KEY_INVALID'); }
    if (derived.split(/\s+/).slice(0, 2).join(' ') !== publicText.split(/\s+/).slice(0, 2).join(' ')) throw coded('Stored SSH keypair does not match.', 'SSH_KEY_INVALID');
    return publicText;
  }

  async function validateKeyDirectory(keys, name) {
    let dir;
    try {
      dir = await fs.promises.open(fdPath(keys, name), directoryFlags);
      return await validateOpenedKeyDirectory(dir);
    } catch (err) {
      if (['ELOOP', 'ENOTDIR'].includes(err.code)) throw coded('Stored SSH keypair directory is unsafe.', 'UNSAFE_PATH');
      throw err;
    } finally { if (dir) await dir.close(); }
  }

  async function ensureSshPublicKey(profileId) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profileId || '') || profileId.length > 63) throw coded('Profile ID is invalid.', 'BAD_REQUEST');
    const keys = await openKeysRoot(); const keysPath = fdPath(keys); let existing;
    try { existing = await fs.promises.lstat(path.join(keysPath, profileId)); } catch (err) { if (err.code !== 'ENOENT') { await keys.close(); throw err; } }
    if (existing) try { return await validateKeyDirectory(keys, profileId); } finally { await keys.close(); }
    const stagedName = `.${profileId}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`; let staged; let published = false;
    try {
      staged = await openChildDirectory(keys, stagedName, true, true);
      await runKeyCommand(['-q', '-t', 'ed25519', '-N', '', '-C', `uponlan:${profileId}`, '-f', fdPath(staged, 'id_ed25519')]);
      await validateOpenedKeyDirectory(staged);
      try { await renameKeyDirectory(path.join(keysPath, stagedName), path.join(keysPath, profileId)); published = true; }
      catch (err) { if (!['EEXIST', 'ENOTEMPTY'].includes(err.code)) throw err; return await validateKeyDirectory(keys, profileId); }
      return await validateKeyDirectory(keys, profileId);
    } catch (err) {
      if (['UNSAFE_PATH', 'SSH_KEY_INVALID'].includes(err.code)) throw err;
      throw coded('SSH keypair could not be generated safely.', 'SSH_KEY_GENERATION_FAILED');
    } finally {
      if (staged) await staged.close().catch(() => {});
      if (!published) try { await fs.promises.rm(path.join(keysPath, stagedName), { recursive: true, force: true }); }
      catch { throw coded('Temporary SSH key material could not be removed safely.', 'SSH_KEY_CLEANUP_FAILED'); }
      await keys.close().catch(() => {});
    }
  }

  return { ensureSshPublicKey };
}

function ensureSshPublicKey(profileId) { return createSshKeyService().ensureSshPublicKey(profileId); }

module.exports = { createSshKeyService, ensureSshPublicKey, validSshPublicKey };
