'use strict';
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { COMPATIBILITY_RECORD } = require('./okdServices');

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 5;
const OKD4_RELEASE = '4.22.0-okd-scos.9';
const OKD4_BASE_URL = `https://github.com/okd-project/okd/releases/download/${OKD4_RELEASE}`;
const OKD4_RECORD = Object.freeze({
  revision: '1',
  release: OKD4_RELEASE,
  architecture: 'linux/amd64',
  releaseImage: 'quay.io/okd/scos-release@sha256:ec8d6dc47890317f33f435200bd7b2de7746c84f2c3d3c39d38510fd9aec6833',
  releaseDigest: 'sha256:ec8d6dc47890317f33f435200bd7b2de7746c84f2c3d3c39d38510fd9aec6833',
  releaseMetadataUrl: `${OKD4_BASE_URL}/release.txt`,
  checksumMetadataUrl: `${OKD4_BASE_URL}/sha256sum.txt`,
  tools: Object.freeze({
    installer: Object.freeze({
      required: true, binary: 'openshift-install', archive: `openshift-install-linux-${OKD4_RELEASE}.tar.gz`,
      archiveSha256: '97d3aa143f6f9f06a5657ca49a9252a57267d09e34f34b6779e7d30413042974',
      sourceUrl: `${OKD4_BASE_URL}/openshift-install-linux-${OKD4_RELEASE}.tar.gz`, maxBytes: 600 * 1024 * 1024,
    }),
    oc: Object.freeze({
      required: false, binary: 'oc', archive: `openshift-client-linux-${OKD4_RELEASE}.tar.gz`,
      archiveSha256: '388fd080e2006fb1277ff0d37a16172fa084bd90d1caf120e056eb8d72850bc9',
      sourceUrl: `${OKD4_BASE_URL}/openshift-client-linux-${OKD4_RELEASE}.tar.gz`, maxBytes: 300 * 1024 * 1024,
    }),
  }),
});

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => execFile(command, args, {
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...options,
  }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function safeDownload(url, destination, { maxBytes, redirects = MAX_REDIRECTS, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { reject(coded('Invalid pinned tool URL.', 'DOWNLOAD_FAILED')); return; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      reject(coded('Pinned tool URL must be credential-free HTTPS.', 'DOWNLOAD_FAILED'));
      return;
    }
    const request = https.get(parsed, { headers: { 'User-Agent': 'UpOnLAN-OKD-tool-preparer' } }, (response) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        if (redirects <= 0) { reject(coded('Tool download exceeded redirect limit.', 'DOWNLOAD_FAILED')); return; }
        let next;
        try { next = new URL(location, parsed); } catch { reject(coded('Tool download returned an invalid redirect.', 'DOWNLOAD_FAILED')); return; }
        safeDownload(next.toString(), destination, { maxBytes, redirects: redirects - 1, timeoutMs }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(coded(`Tool download failed with HTTP ${response.statusCode}.`, 'DOWNLOAD_FAILED'));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.resume();
        reject(coded('Tool archive exceeds the size limit.', 'DOWNLOAD_FAILED'));
        return;
      }
      let received = 0;
      const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) response.destroy(coded('Tool archive exceeds the size limit.', 'DOWNLOAD_FAILED'));
      });
      pipeline(response, output).then(() => resolve({ bytes: received }), reject);
    });
    const timer = setTimeout(() => request.destroy(coded('Tool download timed out.', 'DOWNLOAD_FAILED')), timeoutMs);
    timer.unref();
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

async function lstatOrNull(target) {
  try { return await fs.promises.lstat(target); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function requireDirectory(target) {
  const stat = await lstatOrNull(target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw coded('Refusing unsafe OKD tool cache directory.', 'UNSAFE_PATH');
}

function publicMetadata(metadata) {
  return {
    tool: metadata.tool,
    required: metadata.required,
    release: metadata.release,
    architecture: metadata.architecture,
    releaseImage: metadata.releaseImage,
    releaseDigest: metadata.releaseDigest,
    sourceUrl: metadata.sourceUrl,
    archive: metadata.archive,
    archiveSha256: metadata.archiveSha256,
    binarySha256: metadata.binarySha256,
    compatibilityRevision: metadata.compatibilityRevision,
    preparedAt: metadata.preparedAt,
  };
}

function createToolService({
  record = COMPATIBILITY_RECORD,
  configRoot = process.env.UPONLAN_CONFIG || '/config',
  download = safeDownload,
  run = exec,
  now = () => new Date().toISOString(),
} = {}) {
  const cacheRoot = path.join(configRoot, 'okd', 'cache');
  const okdRoot = path.dirname(cacheRoot);
  const digestKey = record.releaseDigest.replace(':', '-');
  const releaseRoot = path.join(cacheRoot, digestKey);
  const inflight = new Map();
  const live = new Map();
  let preparation = null;

  function toolRecord(name) {
    const tool = record.tools[name];
    if (!tool) throw coded('Unknown OKD tool.', 'BAD_REQUEST');
    return tool;
  }

  async function ensureRoots() {
    await fs.promises.mkdir(configRoot, { recursive: true, mode: 0o700 });
    await requireDirectory(configRoot);
    for (const dir of [okdRoot, cacheRoot]) {
      await fs.promises.mkdir(dir, { mode: 0o700 }).catch((err) => { if (err.code !== 'EEXIST') throw err; });
      await requireDirectory(dir);
    }
    await fs.promises.mkdir(releaseRoot, { mode: 0o700 }).catch((err) => { if (err.code !== 'EEXIST') throw err; });
    await requireDirectory(releaseRoot);
  }

  async function validateVersion(binary, name) {
    let output;
    try {
      const args = name === 'installer' ? ['version'] : ['version', '--client'];
      const result = await run(binary, args, { timeout: COMMAND_TIMEOUT_MS });
      output = `${result.stdout || ''}\n${result.stderr || ''}`;
    } catch (err) {
      const reason = err.code === 'ENOENT' ? 'its required runtime is unavailable'
        : err.code === 'EACCES' ? 'it is not executable'
          : err.killed ? 'version execution timed out' : 'version execution failed';
      throw coded(`Prepared ${name} could not execute: ${reason}.`, 'EXECUTION_FAILED');
    }
    const escaped = record.release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = name === 'installer'
      ? new RegExp(`^(?:\\S+[/\\\\])?openshift-install v?${escaped}\\r?$`, 'm')
      : new RegExp(`^Client Version: v?${escaped}\\r?$`, 'm');
    if (!pattern.test(output)) throw coded(`Prepared ${name} version does not match ${record.release}.`, 'VERSION_MISMATCH');
  }

  function expectedMetadata(name, tool) {
    return {
      tool: name, required: tool.required, release: record.release, architecture: record.architecture,
      releaseImage: record.releaseImage, releaseDigest: record.releaseDigest, sourceUrl: tool.sourceUrl,
      archive: tool.archive, archiveSha256: tool.archiveSha256,
      compatibilityRevision: record.revision,
    };
  }

  async function statusFor(name) {
    const tool = toolRecord(name);
    const base = { tool: name, required: tool.required, ready: false };
    const dir = path.join(releaseRoot, name);
    try {
      if (!await lstatOrNull(dir)) return { ...base, message: 'Not prepared.' };
      await requireDirectory(dir);
      const metadataFile = path.join(dir, 'metadata.json');
      const binary = path.join(dir, tool.binary);
      const [metadataStat, binaryStat] = await Promise.all([lstatOrNull(metadataFile), lstatOrNull(binary)]);
      if (!metadataStat || metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.nlink !== 1 || !binaryStat || binaryStat.isSymbolicLink() || !binaryStat.isFile() || binaryStat.nlink !== 1) throw coded('Cached tool files are incomplete or unsafe.', 'CACHE_INVALID');
      const metadata = JSON.parse(await fs.promises.readFile(metadataFile, 'utf8'));
      const expected = expectedMetadata(name, tool);
      for (const [key, value] of Object.entries(expected)) if (metadata[key] !== value) throw coded('Cached tool metadata does not match the compatibility record.', 'CACHE_INVALID');
      if (!/^[a-f0-9]{64}$/.test(metadata.binarySha256) || await sha256(binary) !== metadata.binarySha256) throw coded('Cached tool binary checksum mismatch.', 'CACHE_INVALID');
      await validateVersion(binary, name);
      return { ...base, ready: true, binaryPath: binary, metadata: publicMetadata(metadata) };
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'UNSAFE_PATH' || err.code === 'CACHE_INVALID' || err.code === 'EXECUTION_FAILED' || err.code === 'VERSION_MISMATCH' || err instanceof SyntaxError) {
        return { ...base, code: err.code || 'CACHE_INVALID', message: err.code === 'ENOENT' ? 'Not prepared.' : err.message };
      }
      throw err;
    }
  }

  async function getStatus(preparing = !!preparation || inflight.size > 0) {
    const tools = {};
    for (const name of Object.keys(record.tools)) {
      // Live progress avoids hashing/executing large sibling binaries on every poll.
      const current = live.get(name);
      tools[name] = current && (preparing || current.state === 'failed') ? current : await statusFor(name);
      tools[name] = { ...tools[name], state: tools[name].state || (tools[name].ready ? 'ready' : tools[name].code ? 'failed' : 'missing') };
    }
    const state = preparing ? 'preparing' : Object.values(tools).some((tool) => tool.state === 'failed') ? 'failed'
      : Object.values(tools).every((tool) => !tool.required || tool.ready) ? 'ready' : 'missing';
    return {
      state,
      release: record.release,
      architecture: record.architecture,
      releaseImage: record.releaseImage,
      releaseDigest: record.releaseDigest,
      compatibilityRevision: record.revision,
      releaseMetadataUrl: record.releaseMetadataUrl,
      checksumMetadataUrl: record.checksumMetadataUrl,
      generationReady: state !== 'preparing' && Object.values(tools).every((tool) => !tool.required || tool.ready),
      tools,
    };
  }

  async function prepareUnlocked(name) {
    const tool = toolRecord(name);
    await ensureRoots();
    const existing = await statusFor(name);
    if (existing.ready) return existing;
    const staging = path.join(releaseRoot, `.${name}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const archive = path.join(staging, tool.archive);
    const extractRoot = path.join(staging, 'extract');
    const finalDir = path.join(releaseRoot, name);
    try {
      await fs.promises.mkdir(extractRoot, { recursive: true, mode: 0o700 });
      await download(tool.sourceUrl, archive, { maxBytes: tool.maxBytes, redirects: MAX_REDIRECTS, timeoutMs: DOWNLOAD_TIMEOUT_MS });
      if (await sha256(archive) !== tool.archiveSha256) throw coded(`Downloaded ${name} archive checksum mismatch.`, 'CHECKSUM_MISMATCH');
      const listed = await run('tar', ['-tzf', archive], { timeout: COMMAND_TIMEOUT_MS });
      const members = String(listed.stdout || '').split(/\r?\n/).filter(Boolean);
      const candidates = members.filter((member) => member === tool.binary || member === `./${tool.binary}`);
      if (candidates.length !== 1) throw coded(`Archive does not contain exactly one root ${tool.binary} binary.`, 'UNSAFE_ARCHIVE');
      await run('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', extractRoot, candidates[0]], { timeout: COMMAND_TIMEOUT_MS });
      const extracted = path.join(extractRoot, tool.binary);
      const alternate = path.join(extractRoot, '.', tool.binary);
      const binary = await lstatOrNull(extracted) ? extracted : alternate;
      const stat = await lstatOrNull(binary);
      if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw coded(`Archive ${tool.binary} is not a safe regular file.`, 'UNSAFE_ARCHIVE');
      await fs.promises.chmod(binary, 0o700);
      await validateVersion(binary, name);
      const metadata = { ...expectedMetadata(name, tool), binarySha256: await sha256(binary), preparedAt: now() };
      await fs.promises.unlink(archive);
      await fs.promises.rename(extractRoot, path.join(staging, name));
      await fs.promises.writeFile(path.join(staging, name, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      const old = await lstatOrNull(finalDir);
      if (old) {
        if (old.isSymbolicLink() || !old.isDirectory()) throw coded('Refusing unsafe existing tool cache.', 'UNSAFE_PATH');
        await fs.promises.rm(finalDir, { recursive: true });
      }
      await fs.promises.rename(path.join(staging, name), finalDir);
      return { tool: name, required: tool.required, ready: true, binaryPath: path.join(finalDir, tool.binary), metadata: publicMetadata(metadata) };
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }

  function prepare(name) {
    toolRecord(name);
    if (!inflight.has(name)) {
      live.set(name, { tool: name, required: record.tools[name].required, ready: false, state: 'preparing' });
      const promise = prepareUnlocked(name).then((value) => {
        live.set(name, { ...value, state: 'ready' });
        return value;
      }, (err) => {
        const code = err && err.code;
        const messages = {
          DOWNLOAD_FAILED: 'Download failed or timed out.', CHECKSUM_MISMATCH: 'Archive checksum mismatch.',
          VERSION_MISMATCH: 'Tool version does not match the saved release.', EXECUTION_FAILED: 'Tool version verification could not execute.',
          UNSAFE_ARCHIVE: 'Archive content is unsafe.', UNSAFE_PATH: 'Tool cache path is unsafe.', CACHE_INVALID: 'Tool cache is invalid.',
        };
        live.set(name, { tool: name, required: record.tools[name].required, ready: false, state: 'failed',
          code: messages[code] ? code : 'PREPARATION_FAILED', message: messages[code] || 'Tool preparation failed.' });
        throw err;
      }).finally(() => inflight.delete(name));
      inflight.set(name, promise);
    }
    return inflight.get(name);
  }

  function installAll() {
    if (!preparation) {
      // Attach both rejection handlers immediately; a failed sibling must not finish the release task early.
      preparation = Promise.allSettled(Object.keys(record.tools).map(prepare)).then(() => getStatus(false));
      preparation = preparation.finally(() => { preparation = null; });
    }
    return preparation;
  }

  async function getVerifiedTool(name) {
    const status = await statusFor(name);
    if (!status.ready) throw coded(status.message || `The exact ${name} binary is not verified.`, name === 'installer' ? 'INSTALLER_NOT_READY' : 'OC_NOT_READY');
    return {
      path: path.join(releaseRoot, name, record.tools[name].binary),
      metadata: status.metadata,
    };
  }

  const getVerifiedInstaller = () => getVerifiedTool('installer');
  const getVerifiedOc = () => getVerifiedTool('oc');

  return { getStatus, prepare, installAll, getVerifiedInstaller, getVerifiedOc };
}

const releases = Object.freeze([OKD4_RELEASE, COMPATIBILITY_RECORD.release]);
const services = new Map([
  [OKD4_RELEASE, createToolService({ record: OKD4_RECORD })],
  [COMPATIBILITY_RECORD.release, createToolService()],
]);

function serviceFor(release = COMPATIBILITY_RECORD.release) {
  const service = services.get(release);
  if (!service) throw coded('Unknown OKD release.', 'BAD_REQUEST');
  return service;
}

const generationService = services.get(COMPATIBILITY_RECORD.release);
module.exports = {
  createToolService, safeDownload, supportedReleases: releases,
  getToolStatus: async (release) => serviceFor(release).getStatus(),
  installTools: async (release) => serviceFor(release).installAll(),
  getVerifiedInstaller: generationService.getVerifiedInstaller,
  getVerifiedOc: generationService.getVerifiedOc,
};
