// ROM / boot-media build runner. Replaces the old Ansible build playbook: it
// shells out to scripts/build_ipxe_roms.sh (copied into the image at /scripts),
// streaming progress and logging to /logs/rom. No ansible involved.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const BUILD_SCRIPT = process.env.UPONLAN_ROM_BUILD_SCRIPT || '/scripts/build_ipxe_roms.sh';
const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
// Media-mode output: the TFTP/HTTP ROM root (nginx serves /config/menus/rom at /rom).
const OUT_ROM = path.join(CONFIG_ROOT, 'menus', 'rom', 'ipxe');
const MANIFEST = path.join(OUT_ROM, 'build-manifest.json');
const SHA256 = /^[a-f0-9]{64}$/;
const FORMAT_FILES = Object.freeze({
  release: ['uponlan.xyz-undionly.kpxe', 'uponlan.xyz.kpxe', 'uponlan.xyz.efi'],
  legacy: ['uponlan.xyz.kpxe', 'uponlan.xyz.dsk', 'uponlan.xyz.pdsk', 'uponlan.xyz.lkrn', 'uponlan.xyz-undionly.kpxe'],
  efi: ['uponlan.xyz.efi', 'uponlan.xyz-snp.efi', 'uponlan.xyz-snponly.efi'],
  iso: ['uponlan.xyz.iso'], usb: ['uponlan.xyz.img'],
});
const BOOT_FILES = [...FORMAT_FILES.legacy, ...FORMAT_FILES.efi].sort();

// Rough number of `[ipxe] ...` steps the build emits, used only for the
// progress-bar denominator (the make step dominates but emits no step line).
const ESTIMATED_STEPS = 8;
const CANCEL_TIMEOUT_MS = Math.max(1, Number(process.env.UPONLAN_ROM_CANCEL_TIMEOUT_MS) || 30000);

let buildState = null; // { process, pid, startedBy, startTime, promise }

function resetBuildState() {
  buildState = null;
}

function buildEnv() {
  const env = { OUT_ROM };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TRUST', 'CERT', 'IPXE_VERSION', 'IPXE_TARBALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function expectedFiles(formats) {
  const requested = (formats || 'release').split(',');
  if (requested.some((format) => !FORMAT_FILES[format])) throw new Error('Unknown ROM build format.');
  return [...new Set(requested.flatMap((format) => FORMAT_FILES[format]))].sort();
}

function validManifest(value, expected) {
  return value && Object.keys(value).sort().join(',') === 'builtAt,files,ipxeVersion,schemaVersion,trustSha256'
    && value.schemaVersion === 1 && value.ipxeVersion === '1.21.1'
    && typeof value.builtAt === 'string' && !Number.isNaN(Date.parse(value.builtAt))
    && (value.trustSha256 === null || SHA256.test(value.trustSha256))
    && Array.isArray(value.files) && value.files.length === expected.length
    && value.files.map((file) => file.name).join('\0') === expected.join('\0')
    && value.files.every((file) => file && Object.keys(file).sort().join(',') === 'name,sha256,size'
      && Number.isSafeInteger(file.size) && file.size > 0 && SHA256.test(file.sha256));
}

async function hashFile(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1) throw new Error('unsafe ROM output');
    const hash = crypto.createHash('sha256'); let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk); }
    return { size, sha256: hash.digest('hex') };
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function readSafeFile(file, maxBytes = 1024 * 1024) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw new Error('unsafe ROM manifest');
    return await handle.readFile();
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function verifyBuildManifest(formats, trustFile) {
  const expected = expectedFiles(formats);
  const manifest = JSON.parse((await readSafeFile(MANIFEST)).toString('utf8'));
  if (!validManifest(manifest, expected)) throw new Error('ROM build manifest is invalid or incomplete.');
  if (trustFile) {
    const trust = await hashFile(trustFile);
    if (manifest.trustSha256 !== trust.sha256) throw new Error('ROM build manifest trust hash does not match the requested certificate.');
  }
  for (const entry of manifest.files) {
    const actual = await hashFile(path.join(OUT_ROM, entry.name));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error(`ROM output failed integrity validation: ${entry.name}`);
  }
  return manifest;
}

function currentBootManifestIdentity() {
  const configRoot = process.env.UPONLAN_CONFIG || '/config';
  let raw;
  try {
    raw = fs.readFileSync(path.join(configRoot, 'menus', 'rom', 'ipxe', 'build-manifest.json'));
  } catch { return null; }
  const manifestHash = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    const manifest = JSON.parse(raw);
    if (!validManifest(manifest, BOOT_FILES)) return `invalid:${manifestHash}`;
    const trust = fs.readFileSync(path.join(configRoot, 'tls', 'server.crt'));
    const trustHash = crypto.createHash('sha256').update(trust).digest('hex');
    return trustHash === manifest.trustSha256 ? manifestHash : `invalid:${manifestHash}:${trustHash}`;
  } catch { return `invalid:${manifestHash}`; }
}

async function startBuild(formats, socket, progressCallback) {
  if (buildState) {
    return { success: false, message: `A build is already running${buildState.pid ? ` (PID ${buildState.pid})` : ''}` };
  }
  const state = { process: null, pid: null, startedBy: socket.id, startTime: new Date(), promise: null };
  buildState = state;
  try {
    const result = runBuild(formats, socket, progressCallback);
    Object.assign(state, { process: result.process, pid: result.process.pid, promise: result.promise });
    (async () => { try { await result.promise; } finally { if (buildState === state) resetBuildState(); } })().catch(() => {});
    return { success: true, message: `Build started (PID ${result.process.pid})`, pid: result.process.pid, promise: result.promise };
  } catch (err) {
    if (buildState === state) resetBuildState();
    return { success: false, message: `Failed to start build: ${err.message}` };
  }
}

async function cancelBuild() {
  if (!buildState || !buildState.process || !buildState.promise) {
    return { success: false, message: 'No build in progress' };
  }
  const running = buildState;
  try {
    process.kill(-running.process.pid, 'SIGTERM');
    const timer = setTimeout(() => {
      if (buildState === running && running.process) try { process.kill(-running.process.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') running.killError = err; }
    }, CANCEL_TIMEOUT_MS);
    const result = await running.promise.finally(() => clearTimeout(timer));
    if (running.killError) return { success: false, message: 'Failed to terminate build process.' };
    return result;
  } catch (err) {
    return { success: false, message: `Failed to cancel build: ${err.message}` };
  }
}

function runBuild(formats, socket, progressCallback) {
  const logDir = path.join(process.env.UPONLAN_LOGS || '/logs', 'rom');
  fs.mkdirSync(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `build_${timestamp}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });

  const args = formats ? [formats] : [];
  const env = buildEnv();
  // Default TRUST to this deployment's own TLS cert so ROMs built in-container
  // verify the asset server they'll boot from. An explicit TRUST env wins.
  if (!env.TRUST) {
    const cert = path.join(CONFIG_ROOT, 'tls', 'server.crt');
    if (fs.existsSync(cert)) env.TRUST = cert;
  }
  let proc;
  try { proc = spawn(BUILD_SCRIPT, args, { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (err) { logStream.destroy(); throw err; }

  const promise = new Promise((resolve, reject) => {
    let step = 0; let settled = false;
    const finish = (result) => { if (settled) return; settled = true; logStream.end(); resolve(result); };
    logStream.on('error', () => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already exited */ }
      finish({ success: false, status: 'error', message: 'Build log could not be written safely.' });
    });
    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line) => {
        logStream.write(line + '\n');
        const m = line.match(/^\[ipxe\] (.+)$/);
        if (m) {
          step += 1;
          if (progressCallback) {
            progressCallback({ tasksCompleted: step, taskCount: ESTIMATED_STEPS, currentTask: m[1] });
          }
        }
      });
    });

    proc.stderr.on('data', (data) => {
      logStream.write(data);
    });

    proc.once('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        finish({ success: false, status: 'cancelled', message: 'Build was cancelled by the user.' });
      } else if (code === 0) {
        Promise.resolve().then(async () => {
          await verifyBuildManifest(formats, env.TRUST);
          finish({ success: true, status: 'success', message: `Build completed successfully. Log: ${logFile}` });
        }).catch((err) => finish({ success: false, status: 'error', message: `Build output validation failed: ${err.message} See log: ${logFile}` }));
      } else {
        finish({ success: false, status: 'error', message: `Build failed with code ${code}. See log: ${logFile}` });
      }
    });

    proc.once('error', (err) => {
      finish({ success: false, status: 'error', message: `Failed to start build: ${err.message}` });
    });
  });

  return { process: proc, promise };
}

module.exports = { startBuild, cancelBuild, verifyBuildManifest, currentBootManifestIdentity };
