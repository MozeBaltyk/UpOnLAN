'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const profiles = require('./okdServices');
const tools = require('./okdToolServices');
const artifacts = require('./okdArtifactServices');
const pullSecrets = require('./okdPullSecretServices');

const ACTIVE = new Set(['queued', 'running', 'finalizing', 'cancelling']);
const LOG_LIMIT = 256 * 1024;
const READ_LIMIT = 64 * 1024;

function coded(message, code, errors) {
  return Object.assign(new Error(message), { code, errors: errors || [] });
}

function installerEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const renderConfigs = profiles.renderConfigs;

function secretValues(value, result = []) {
  if (typeof value === 'string' && value) result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => secretValues(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => secretValues(item, result));
  return result;
}

function makeRedactor(secretText, parsed, privateValues = []) {
  const literals = [...new Set([secretText, secretText.trim(), ...secretValues(parsed), ...privateValues].filter((v) => v && v.length >= 3))]
    .sort((a, b) => b.length - a.length);
  const sanitize = (input) => {
    let text = String(input);
    for (const literal of literals) text = text.split(literal).join('[REDACTED]');
    return text
      .replace(/((?:pull[-_ ]?secret|password|token|credential|authorization|auth|client[-_ ]?(?:key|certificate)[-_ ]?data)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/("(?:pullSecret|password|token|credential|authorization|auth|clientKeyData|clientCertificateData)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
  };
  let pending = '';
  const overlap = Math.max(8192, ...literals.map((value) => value.length + 512));
  return {
    feed(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = pending.split(/(?<=\n)/);
      pending = lines.pop() || '';
      if (pending.length > overlap * 2) { lines.push(pending.slice(0, -overlap)); pending = pending.slice(-overlap); }
      return lines.map(sanitize).join('');
    },
    flush() { const output = sanitize(pending); pending = ''; return output; },
  };
}

function createJobService({
  configRoot = process.env.UPONLAN_CONFIG || '/config',
  logsRoot = process.env.UPONLAN_LOGS || '/logs',
  pullSecretFile = process.env.OKD_PULL_SECRET_FILE || '/run/secrets/okd-pull-secret',
  pullSecretService = null,
  publicBaseUrl = process.env.OKD_PUBLIC_BASE_URL || '',
  persistenceReady = process.env.OKD_PERSISTENCE_READY === 'true',
  getProfile = profiles.getProfile,
  getTemplates = profiles.getTemplates,
  getVerifiedInstaller = tools.getVerifiedInstaller,
  getVerifiedOc = tools.getVerifiedOc,
  finalizeArtifacts = artifacts.finalizeArtifacts,
  spawnProcess = spawn,
  writeJobFile = fs.promises.writeFile,
  renameRecord = fs.promises.rename,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  cancelTimeoutMs = 30000,
  now = () => new Date().toISOString(),
  jobId = () => crypto.randomUUID(),
  auditEvent = async () => {},
} = {}) {
  const jobsRoot = path.join(configRoot, 'okd', 'jobs');
  const workspacesRoot = path.join(configRoot, 'okd', 'workspaces');
  const logRoot = path.join(logsRoot, 'okd');
  const secretService = pullSecretService || pullSecrets.createPullSecretService({
    configRoot, externalFile: pullSecretFile,
    externalConfigured: Object.hasOwn(process.env, 'OKD_PULL_SECRET_FILE') || pullSecretFile !== '/run/secrets/okd-pull-secret',
  });
  let initialized;
  let active = null;
  let starting = false;
  let startingProfileId = null;
  let audit = auditEvent;
  const volatileRecords = new Map();

  function publicRecord(record) {
    if (!record || !/^[0-9a-f-]{16,64}$/.test(record.id || '') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.profileId || '')) return null;
    return {
      id: record.id, profileId: record.profileId, profileRevision: record.profileRevision,
      state: record.state, createdAt: record.createdAt, startedAt: record.startedAt || null,
      finishedAt: record.finishedAt || null, release: record.release,
      releaseImage: record.releaseImage, releaseDigest: record.releaseDigest,
      compatibilityRevision: record.compatibilityRevision,
      installerArchiveSha256: record.installerArchiveSha256,
      installerBinarySha256: record.installerBinarySha256,
      mode: ['pxe', 'iso'].includes(record.mode) ? record.mode : 'pxe',
      versionId: /^[0-9a-f-]{16,64}$/.test(record.versionId || '') ? record.versionId : null,
      errorCode: ['ARTIFACT_FINALIZATION_FAILED', 'PERSISTENCE_FAILED'].includes(record.errorCode) ? record.errorCode : null,
      log: record.log === `${record.id}.log` ? record.log : `${record.id}.log`,
      message: typeof record.message === 'string' ? record.message.slice(0, 500) : '',
      ...(record.context && /^[a-z0-9.-]{1,253}$/.test(record.context.clusterName || '') && /^[a-z0-9.-]{1,253}$/.test(record.context.baseDomain || '')
        && ['sno', 'compact', 'standard'].includes(record.context.topology) && Array.isArray(record.context.hosts) && record.context.hosts.length <= 23
        && record.context.hosts.every((host) => host && /^[a-z0-9-]{1,63}$/.test(host.hostname || '') && ['master', 'worker'].includes(host.role)
          && host.rootDeviceHints && Object.keys(host.rootDeviceHints).length === 1 && Object.entries(host.rootDeviceHints).every(([key, value]) => ['wwn', 'serialNumber', 'deviceName'].includes(key) && typeof value === 'string' && value.length <= 256))
        ? { context: { clusterName: record.context.clusterName, baseDomain: record.context.baseDomain, topology: record.context.topology,
          hosts: record.context.hosts.map((host) => ({ hostname: host.hostname, role: host.role, rootDeviceHints: { ...host.rootDeviceHints } })) } } : {}),
    };
  }

  async function safeRoot(base, dir) {
    const resolvedBase = path.resolve(base);
    const resolvedDir = path.resolve(dir);
    if (resolvedDir !== resolvedBase && !resolvedDir.startsWith(`${resolvedBase}${path.sep}`)) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
    await fs.promises.mkdir(resolvedBase, { recursive: true, mode: 0o700 });
    const baseStat = await fs.promises.lstat(resolvedBase);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
    let current = resolvedBase;
    for (const part of path.relative(resolvedBase, resolvedDir).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      await fs.promises.mkdir(current, { mode: 0o700 }).catch((err) => { if (err.code !== 'EEXIST') throw err; });
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
    }
    if (resolvedDir !== resolvedBase) await fs.promises.chmod(resolvedDir, 0o700);
  }

  async function atomicRecord(record) {
    const file = path.join(jobsRoot, `${record.id}.json`);
    const temp = path.join(jobsRoot, `.${record.id}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeJobFile(temp, `${JSON.stringify(publicRecord(record), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await renameRecord(temp, file);
    } finally { await fs.promises.rm(temp, { force: true }); }
  }

  async function readRecords() {
    await safeRoot(configRoot, jobsRoot);
    const records = [];
    for (const name of await fs.promises.readdir(jobsRoot)) {
      if (!/^[0-9a-f-]+\.json$/.test(name)) continue;
      const file = path.join(jobsRoot, name);
      const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      try {
        const record = publicRecord(JSON.parse(await fs.promises.readFile(file, 'utf8')));
        if (record) records.push(record);
      } catch { /* ignore invalid records */ }
    }
    for (const record of volatileRecords.values()) {
      const index = records.findIndex((item) => item.id === record.id);
      if (index === -1) records.push(record); else records[index] = record;
    }
    return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      await Promise.all([safeRoot(configRoot, jobsRoot), safeRoot(configRoot, workspacesRoot), safeRoot(logsRoot, logRoot)]);
      for (const record of await readRecords()) {
        if (ACTIVE.has(record.state)) {
          record.state = 'interrupted';
          record.finishedAt = now();
          record.message = 'Generation was interrupted by an application restart.';
          await atomicRecord(record);
        }
      }
    })();
    return initialized;
  }

  function validateEnvironment() {
    const errors = [];
    if (!persistenceReady) errors.push({ field: 'persistence', message: 'Persistent OKD config and log storage is not configured.' });
    try {
      const url = new URL(publicBaseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    } catch { errors.push({ field: 'public_base_url', message: 'Configure a credential-free HTTPS OKD_PUBLIC_BASE_URL origin.' }); }
    return errors;
  }

  async function preflight(profileId, revision) {
    await initialize();
    const errors = validateEnvironment();
    let profile;
    try {
      profile = await getProfile(profileId);
      if (!/^[a-f0-9]{64}$/.test(revision || '') || profile.revision !== revision) errors.push({ field: 'revision', message: 'Save or reload the changed profile before generation.' });
    } catch (err) { errors.push({ field: 'profile', message: err.message }); }
    try { await secretService.resolve(); } catch (err) { errors.push({ field: 'pull_secret', message: err.message }); }
    try { await getVerifiedInstaller(); } catch (err) { errors.push({ field: 'installer', message: err.message }); }
    try { await getVerifiedOc(); } catch (err) { errors.push({ field: 'oc', message: err.message }); }
    if (active) errors.push({ field: 'job', message: `Another generation job for profile ${active.record.profileId} is active on this instance.` });
    return { ready: errors.length === 0, errors, profileRevision: profile && profile.revision };
  }

  async function appendLog(file, text, state) {
    if (!text || state.logBytes >= LOG_LIMIT) return;
    const chunk = Buffer.from(text).subarray(0, LOG_LIMIT - state.logBytes);
    await fs.promises.appendFile(file, chunk, { mode: 0o600 });
    state.logBytes += chunk.length;
  }

  async function startUnlocked({ profileId, revision, confirmed, mode = 'pxe' }) {
    await initialize();
    if (confirmed !== true) throw coded('Confirm that generation targets the declared disks and may lead to destructive installation.', 'CONFIRMATION_REQUIRED');
    if (!['pxe', 'iso'].includes(mode)) throw coded('Generation mode must be pxe or iso.', 'BAD_REQUEST');
    const check = await preflight(profileId, revision);
    if (!check.ready) throw coded('OKD generation preflight failed.', 'PREFLIGHT_FAILED', check.errors);
    const profile = await getProfile(profileId);
    if (profile.revision !== revision) throw coded('OKD generation preflight failed.', 'PREFLIGHT_FAILED', [{ field: 'revision', message: 'Save or reload the changed profile before generation.' }]);
    const pullSecret = await secretService.resolve();
    const installer = await getVerifiedInstaller();
    const oc = await getVerifiedOc();
    const id = jobId();
    if (!/^[0-9a-f-]{16,64}$/.test(id)) throw coded('Generated job ID is invalid.', 'INTERNAL');
    const profileRoot = path.join(workspacesRoot, profile.id);
    const workspace = path.join(profileRoot, id);
    const record = {
      id, profileId: profile.id, profileRevision: profile.revision, state: 'queued', createdAt: now(),
      startedAt: null, finishedAt: null, release: profiles.COMPATIBILITY_RECORD.release,
      releaseImage: profiles.COMPATIBILITY_RECORD.releaseImage, releaseDigest: profiles.COMPATIBILITY_RECORD.releaseDigest,
      compatibilityRevision: profiles.COMPATIBILITY_RECORD.revision,
      installerArchiveSha256: installer.metadata.archiveSha256,
      installerBinarySha256: installer.metadata.binarySha256,
      mode, versionId: null, errorCode: null,
      log: `${id}.log`, message: 'Generation queued.',
    };
    const logFile = path.join(logRoot, record.log);
    let child;
    try {
      await safeRoot(workspacesRoot, profileRoot);
      await fs.promises.mkdir(workspace, { mode: 0o700 });
      const templates = await getTemplates(profile.id, revision);
      record.context = profiles.effectiveContext(profile, templates);
      const installConfig = yaml.load(templates.installConfig, { schema: yaml.JSON_SCHEMA });
      installConfig.pullSecret = pullSecret.raw;
      const agentConfig = yaml.load(templates.agentConfig, { schema: yaml.JSON_SCHEMA });
      if (mode === 'pxe') agentConfig.bootArtifactsBaseURL = `${new URL(publicBaseUrl).toString()}okd/${profile.id}/${id}`;
      await Promise.all([
        writeJobFile(path.join(workspace, 'install-config.yaml'), yaml.dump(installConfig, { noRefs: true, lineWidth: -1, sortKeys: false }), { flag: 'wx', mode: 0o600 }),
        writeJobFile(path.join(workspace, 'agent-config.yaml'), yaml.dump(agentConfig, { noRefs: true, lineWidth: -1, sortKeys: false }), { flag: 'wx', mode: 0o600 }),
      ]);
      await writeJobFile(logFile, '', { flag: 'wx', mode: 0o600 });
      await atomicRecord(record);
      try {
        child = spawnProcess(installer.path, ['agent', 'create', mode === 'iso' ? 'image' : 'pxe-files', '--dir', workspace], {
          cwd: workspace, env: { ...installerEnv(), PATH: `${path.dirname(oc.path)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}` }, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { throw coded('Installer could not be started.', 'SPAWN_FAILED'); }
    } catch (err) {
      await Promise.all([
        fs.promises.rm(workspace, { recursive: true, force: true }),
        fs.promises.rm(logFile, { force: true }),
        fs.promises.rm(path.join(jobsRoot, `${id}.json`), { force: true }),
      ]).catch(() => {});
      await fs.promises.rmdir(profileRoot).catch((cleanupError) => { if (cleanupError.code !== 'ENOENT' && cleanupError.code !== 'ENOTEMPTY') throw cleanupError; });
      throw err;
    }
    const redactor = makeRedactor(pullSecret.raw, pullSecret.parsed, [workspace]);
    const logState = { logBytes: 0 };
    let logChain = Promise.resolve();
    const consume = (chunk) => { logChain = logChain.then(() => appendLog(logFile, redactor.feed(chunk), logState)).catch(() => {}); };
    let finishChild;
    const pendingChildEvents = [];
    child.once('error', () => (finishChild ? finishChild(null, null, true).catch(() => {}) : pendingChildEvents.push([null, null, true])));
    child.once('close', (code, signal) => (finishChild ? finishChild(code, signal, false).catch(() => {}) : pendingChildEvents.push([code, signal, false])));
    let finishResolve; let startupPersistenceFailed = false;
    const finished = new Promise((resolve) => { finishResolve = resolve; });
    const running = { id, child, record, finished, killTimer: null };
    active = running;
    if (child.stdout) child.stdout.on('data', consume);
    if (child.stderr) child.stderr.on('data', consume);
    let setupResolve;
    const setupComplete = new Promise((resolve) => { setupResolve = resolve; });
    let settled = false;
    const finish = async (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      await setupComplete;
      try {
        running.child = null;
        await logChain;
        await appendLog(logFile, redactor.flush(), logState).catch(() => {});
        if (!startupPersistenceFailed) {
          if (record.state === 'cancelling') { record.state = 'cancelled'; record.message = 'Generation cancelled.'; }
          else if (!spawnError && code === 0) {
            record.state = 'finalizing'; record.message = 'Installer completed; artifacts are being verified.';
            try { await atomicRecord(record); } catch {
              record.state = 'failed'; record.errorCode = 'PERSISTENCE_FAILED'; record.message = 'Job state could not be persisted safely.';
            }
            if (!record.errorCode) try {
              const version = await finalizeArtifacts({ workspace, profile, job: record, mode });
              record.state = 'succeeded'; record.versionId = version.versionId; record.message = 'Installer artifacts finalized.';
            } catch {
              record.state = 'failed'; record.errorCode = 'ARTIFACT_FINALIZATION_FAILED'; record.message = 'Installer artifacts could not be finalized safely.';
            }
          } else { record.state = 'failed'; record.message = signal ? 'Installer was terminated unexpectedly.' : 'Installer generation failed.'; }
        }
        record.finishedAt = now();
        try { await atomicRecord(record); } catch {
          record.state = 'failed'; record.errorCode = 'PERSISTENCE_FAILED'; record.versionId = null; record.message = 'Job state could not be persisted safely.';
          try { await atomicRecord(record); } catch { record.state = 'persistence_failed'; volatileRecords.set(record.id, publicRecord(record)); }
        }
      } finally {
        clearTimeout(running.killTimer);
        if (active === running) active = null;
        await audit('generation.result', record.state === 'succeeded' ? 'succeeded' : record.state, {
          profileId: record.profileId, versionId: record.versionId, jobId: record.id, mode: record.mode,
        }).catch(() => {});
        finishResolve(record);
      }
    };
    finishChild = finish;
    for (const event of pendingChildEvents) finish(...event).catch(() => {});
    record.state = 'running'; record.startedAt = now(); record.message = 'Installer is running.';
    try { await atomicRecord(record); setupResolve(); }
    catch {
      startupPersistenceFailed = true; record.state = 'failed'; record.errorCode = 'PERSISTENCE_FAILED'; record.message = 'Job state could not be persisted safely.'; setupResolve();
      try { killGroup(child.pid, 'SIGTERM'); } catch { /* bounded KILL remains */ }
      running.killTimer = setTimeout(() => { if (running.child) try { killGroup(child.pid, 'SIGKILL'); } catch { /* already exited */ } }, cancelTimeoutMs); running.killTimer.unref();
      throw coded(record.message, 'PERSISTENCE_FAILED');
    }
    return record;
  }

  function start(request) {
    if (starting || active) return Promise.reject(coded('Another generation job is active on this instance.', 'JOB_ACTIVE'));
    starting = true;
    startingProfileId = request && request.profileId;
    return startUnlocked(request).finally(() => { starting = false; startingProfileId = null; });
  }

  async function cancel(id) {
    await initialize();
    if (!active || active.id !== id || !active.child) throw coded('That installer process is not active on this application instance.', 'NOT_ACTIVE');
    const running = active;
    const pid = running.child.pid;
    running.record.state = 'cancelling'; running.record.message = 'Cancellation requested.';
    await atomicRecord(running.record);
    try { killGroup(pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    let timer;
    await Promise.race([
      running.finished,
      new Promise((resolve, reject) => { timer = setTimeout(() => {
        if (active === running && running.child) { try { killGroup(pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') { reject(err); return; } } }
        resolve();
      }, cancelTimeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    return running.record;
  }

  async function status(profileId) {
    await initialize();
    const history = (await readRecords()).filter((record) => !profileId || record.profileId === profileId).slice(0, 50);
    const current = active && (!profileId || active.record.profileId === profileId)
      ? { ...publicRecord(active.record), cancellable: !!active.child } : null;
    const blocking = active && profileId && active.record.profileId !== profileId
      ? { id: active.record.id, profileId: active.record.profileId, state: active.record.state, mode: active.record.mode } : null;
    return { current, blocking, history };
  }

  function isProfileActive(profileId) {
    return startingProfileId === profileId || !!(active && active.record.profileId === profileId);
  }

  function isActive() { return starting || !!active; }
  function setAuditSink(sink) { audit = typeof sink === 'function' ? sink : async () => {}; }

  async function readLog(id, maxBytes = READ_LIMIT) {
    await initialize();
    if (!/^[0-9a-f-]{16,64}$/.test(id)) throw coded('Invalid job ID.', 'BAD_REQUEST');
    const limit = Math.min(READ_LIMIT, Math.max(1, Number(maxBytes) || READ_LIMIT));
    const file = path.join(logRoot, `${id}.log`);
    let handle;
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw coded('Job log is unsafe.', 'UNSAFE_PATH');
      const length = Math.min(limit, stat.size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return { jobId: id, text: buffer.toString('utf8'), truncated: stat.size > length };
    } catch (err) {
      if (err.code === 'ENOENT') throw coded('Job log not found.', 'NOT_FOUND');
      if (err.code === 'ELOOP') throw coded('Job log is unsafe.', 'UNSAFE_PATH');
      throw err;
    } finally { if (handle) await handle.close(); }
  }

  return { initialize, preflight, start, cancel, status, readLog, isProfileActive, isActive, setAuditSink };
}

const service = createJobService();
module.exports = { createJobService, renderConfigs, makeRedactor, initialize: service.initialize, preflight: service.preflight, startJob: service.start, cancelJob: service.cancel, getJobStatus: service.status, readJobLog: service.readLog, isProfileActive: service.isProfileActive, isActive: service.isActive, setAuditSink: service.setAuditSink };
