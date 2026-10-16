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
const { createSshKeyService } = require('./okdSshKeyServices');

const ACTIVE = new Set(['queued', 'running', 'finalizing', 'cancelling']);
const STATES = new Set([...ACTIVE, 'succeeded', 'failed', 'cancelled', 'interrupted', 'persistence_failed']);
const SHA256 = /^[a-f0-9]{64}$/;
const MESSAGES = new Set(['Generation queued.', 'Installer is running.', 'Installer completed; artifacts are being verified.', 'Installer artifacts finalized.', 'Generation cancelled.', 'Installer was terminated unexpectedly.', 'Installer generation failed.', 'Job state could not be persisted safely.', 'Generation was interrupted by an application restart.', 'Cancellation requested.']);
const LOG_LIMIT = 256 * 1024;
const READ_LIMIT = 64 * 1024;

function coded(message, code, errors) {
  return Object.assign(new Error(message), { code, errors: errors || [] });
}

function installerEnv(workspace) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = workspace;
  env.XDG_CACHE_HOME = path.join(workspace, '.cache');
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
  persistenceReady = process.env.OKD_PERSISTENCE_READY === 'true',
  getProfile = profiles.getProfile,
  getTemplates = profiles.getTemplates,
  getVerifiedInstaller = tools.getVerifiedInstaller,
  getVerifiedOc = tools.getVerifiedOc,
  finalizeArtifacts = artifacts.finalizeArtifacts,
  spawnProcess = spawn,
  runKeyCommand,
  renameKeyDirectory = fs.promises.rename,
  writeJobFile = fs.promises.writeFile,
  renameRecord = fs.promises.rename,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  cancelTimeoutMs = 30000,
  now = () => new Date().toISOString(),
  auditEvent = async () => {},
} = {}) {
  const jobsRoot = path.join(configRoot, 'okd', 'jobs');
  const workspacesRoot = path.join(configRoot, 'okd', 'workspaces');
  const sequencesRoot = path.join(configRoot, 'okd', 'sequences');
  const generationLockFile = path.join(configRoot, 'okd', 'generation.lock');
  const logRoot = path.join(logsRoot, 'okd');
  const secretService = pullSecretService || pullSecrets.createPullSecretService({
    configRoot, externalFile: pullSecretFile,
    externalConfigured: Object.hasOwn(process.env, 'OKD_PULL_SECRET_FILE') || pullSecretFile !== '/run/secrets/okd-pull-secret',
  });
  const keyService = createSshKeyService({ configRoot, ...(runKeyCommand ? { runKeyCommand } : {}), renameKeyDirectory });
  let initialized;
  let active = null;
  let starting = false;
  let startingProfileId = null;
  let audit = auditEvent;
  const volatileRecords = new Map();

  function publicRecord(record) {
    if (!record || !/^v[1-9][0-9]*$/.test(record.mediaVersion || '') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.profileId || '')
      || record.release !== profiles.COMPATIBILITY_RECORD.release || !SHA256.test(record.profileRevision || '') || !STATES.has(record.state)
      || !SHA256.test(record.installerArchiveSha256 || '') || !SHA256.test(record.installerBinarySha256 || '')
      || record.releaseImage !== profiles.COMPATIBILITY_RECORD.releaseImage || record.releaseDigest !== profiles.COMPATIBILITY_RECORD.releaseDigest
      || record.compatibilityRevision !== profiles.COMPATIBILITY_RECORD.revision || !Number.isFinite(Date.parse(record.createdAt))
      || ![record.startedAt, record.finishedAt].every((value) => value === null || value === undefined || Number.isFinite(Date.parse(value)))) return null;
    let destinationUrl = null;
    try {
      const value = new URL(record.destinationUrl);
      const suffix = `/okd/${record.profileId}/${record.release}/${record.mediaVersion}/`;
      if (value.protocol === 'https:' && !value.username && !value.password && !value.search && !value.hash && value.pathname.endsWith(suffix)) destinationUrl = value.toString();
    } catch { /* ISO and malformed persisted destinations remain absent. */ }
    return {
      profileId: record.profileId, profileRevision: record.profileRevision, mediaVersion: record.mediaVersion,
      state: record.state, createdAt: record.createdAt, startedAt: record.startedAt || null,
      finishedAt: record.finishedAt || null, release: record.release,
      releaseImage: record.releaseImage, releaseDigest: record.releaseDigest,
      compatibilityRevision: record.compatibilityRevision,
      installerArchiveSha256: record.installerArchiveSha256,
      installerBinarySha256: record.installerBinarySha256,
      mode: ['pxe', 'iso'].includes(record.mode) ? record.mode : 'pxe',
      destinationUrl,
      versionId: /^v[1-9][0-9]*$/.test(record.versionId || '') ? record.versionId : null,
      errorCode: ['ARTIFACT_FINALIZATION_FAILED', 'PERSISTENCE_FAILED'].includes(record.errorCode) ? record.errorCode : null,
      message: MESSAGES.has(record.message) ? record.message : '',
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

  async function acquireGenerationLock() {
    await safeRoot(configRoot, path.dirname(generationLockFile));
    const processStart = async (pid) => {
      const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    };
    for (;;) {
      const token = crypto.randomBytes(16).toString('hex');
      try {
        await fs.promises.writeFile(generationLockFile, `${JSON.stringify({ pid: process.pid, started: await processStart(process.pid), token })}\n`, { flag: 'wx', mode: 0o600 });
        return { token };
      } catch (err) {
        if (err.code !== 'EEXIST') throw coded('Generation lock could not be acquired safely.', 'PERSISTENCE_FAILED');
        let owner;
        try { owner = JSON.parse(await require('./safeFile').readBounded(generationLockFile, 1024)); } catch { throw coded('Generation lock is invalid.', 'PERSISTENCE_FAILED'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.started !== 'string' || typeof owner.token !== 'string') throw coded('Generation lock is invalid.', 'PERSISTENCE_FAILED');
        try {
          process.kill(owner.pid, 0);
          if (await processStart(owner.pid) === owner.started) throw coded('Another generation process is active.', 'JOB_ACTIVE');
        }
        catch (probe) {
          if (probe.code === 'JOB_ACTIVE' || probe.code === 'EPERM') throw coded('Another generation process is active.', 'JOB_ACTIVE');
          if (!['ESRCH', 'ENOENT'].includes(probe.code)) throw probe;
        }
        await fs.promises.rm(generationLockFile, { force: true });
      }
    }
  }

  async function releaseGenerationLock(lock) {
    if (!lock) return;
    try {
      const owner = JSON.parse(await require('./safeFile').readBounded(generationLockFile, 1024));
      if (owner.token === lock.token) await fs.promises.rm(generationLockFile);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }

  async function atomicRecord(record) {
    // publicRecord() drops any record it cannot fully validate. Persisting that
    // as literal `null` would silently erase the job from disk, so fail closed.
    const safe = publicRecord(record);
    if (!safe) throw coded('Job state could not be persisted safely.', 'PERSISTENCE_FAILED');
    const file = path.join(jobsRoot, `${record.id}.json`);
    const temp = path.join(jobsRoot, `.${record.id}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeJobFile(temp, `${JSON.stringify(safe, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await renameRecord(temp, file);
    } finally { await fs.promises.rm(temp, { force: true }); }
  }

  async function readRecords() {
    await safeRoot(configRoot, jobsRoot);
    const records = [];
    for (const name of await fs.promises.readdir(jobsRoot)) {
      if (!/^[a-z0-9.-]+--v[1-9][0-9]*\.json$/.test(name)) continue;
      const file = path.join(jobsRoot, name);
      const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      try {
        const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
        const record = publicRecord(value);
        if (record) record.id = name.slice(0, -5);
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
      await Promise.all([safeRoot(configRoot, jobsRoot), safeRoot(configRoot, workspacesRoot), safeRoot(configRoot, sequencesRoot), safeRoot(logsRoot, logRoot)]);
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

  function validateEnvironment(profile) {
    const errors = [];
    if (!persistenceReady) errors.push({ field: 'persistence', message: 'Persistent OKD config and log storage is not configured.' });
    if (profile && profile.boot_mode === 'pxe') try { require('./localAssetSettings').validateOrigin(profile.asset_url); }
    catch (err) { errors.push({ field: 'asset_url', message: err.message }); }
    return { errors };
  }

  async function preflight(profileId, revision) {
    await initialize();
    const errors = []; let profile;
    try {
      profile = await getProfile(profileId);
      if (!/^[a-f0-9]{64}$/.test(revision || '') || profile.revision !== revision) errors.push({ field: 'revision', message: 'Save or reload the changed profile before generation.' });
    } catch (err) { errors.push({ field: 'profile', message: err.message }); }
    errors.push(...validateEnvironment(profile).errors);
    try { await secretService.resolve(); } catch (err) { errors.push({ field: 'pull_secret', message: err.message }); }
    try { await getVerifiedInstaller(); } catch (err) { errors.push({ field: 'installer', message: err.message }); }
    try { await getVerifiedOc(); } catch (err) { errors.push({ field: 'oc', message: err.message }); }
    if (active) errors.push({ field: 'job', message: `Another generation job for profile ${active.record.profileId} is active on this instance.` });
    if (profile && profile.boot_mode === 'pxe' && !errors.some((error) => ['profile', 'asset_url'].includes(error.field))) try {
      const inspected = await require('./assetCertificateServices').inspectEndpoint({ origin: profile.asset_url, configRoot, storedPem: profile.asset_certificate_bundle, additionalPem: profile.additional_ca_bundle });
      if (!inspected.metadata.hostnameMatch || inspected.metadata.validity !== 'current' || inspected.metadata.storedMismatch
        || (!inspected.metadata.systemTrusted && !profile.asset_certificate_bundle && !inspected.metadata.additionalCaMatch)) errors.push({ field: 'asset_certificate_bundle', message: 'Asset server certificate must be inspected and explicitly resolved.' });
    } catch (err) { errors.push({ field: 'asset_certificate_bundle', message: err.message }); }
    return { ready: errors.length === 0, errors, profileRevision: profile && profile.revision, mode: profile && profile.boot_mode,
      destination: profile && profile.boot_mode === 'pxe' ? `${profile.asset_url}okd/${profile.id}/${profile.release}/<next-media-version>/` : null };
  }

  async function allocateVersion(profile) {
    const dir = path.join(sequencesRoot, profile.id); await safeRoot(sequencesRoot, dir);
    const file = path.join(dir, `${profile.release}.json`); let next = 1;
    try { const value = JSON.parse(await require('./safeFile').readBounded(file, 64 * 1024)); if (Number.isSafeInteger(value.next) && value.next > 0) next = value.next; } catch (err) { if (err.code !== 'ENOENT') throw coded('Media version sequence is invalid.', 'PERSISTENCE_FAILED'); }
    const escapedRelease = profile.release.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const name of await fs.promises.readdir(dir)) { const match = new RegExp(`^${escapedRelease}--v([1-9][0-9]*)\\.allocated$`).exec(name); if (match) next = Math.max(next, Number(match[1]) + 1); }
    const artifactsRoot = path.join(process.env.UPONLAN_ASSETS || '/assets', 'okd', profile.id, profile.release);
    try { for (const name of await fs.promises.readdir(artifactsRoot)) if (/^v[1-9][0-9]*$/.test(name)) next = Math.max(next, Number(name.slice(1)) + 1); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    let mediaVersion;
    for (;;) {
      mediaVersion = `v${next}`;
      try { await fs.promises.writeFile(path.join(dir, `${profile.release}--${mediaVersion}.allocated`), '', { flag: 'wx', mode: 0o600 }); break; }
      catch (err) { if (err.code !== 'EEXIST') throw coded('Media version could not be allocated.', 'PERSISTENCE_FAILED'); next += 1; }
    }
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { await fs.promises.writeFile(temp, `${JSON.stringify({ next: next + 1 })}\n`, { flag: 'wx', mode: 0o600 }); await fs.promises.rename(temp, file); }
    finally { await fs.promises.rm(temp, { force: true }); }
    return mediaVersion;
  }

  async function appendLog(file, text, state) {
    if (!text || state.logBytes >= LOG_LIMIT) return;
    const chunk = Buffer.from(text).subarray(0, LOG_LIMIT - state.logBytes);
    await fs.promises.appendFile(file, chunk, { mode: 0o600 });
    state.logBytes += chunk.length;
  }

  async function startUnlocked({ profileId, revision, confirmed }, generationLock) {
    await initialize();
    if (confirmed !== true) throw coded('Confirm that generation targets the declared disks and may lead to destructive installation.', 'CONFIRMATION_REQUIRED');
    const check = await preflight(profileId, revision);
    if (!check.ready) throw coded('OKD generation preflight failed.', 'PREFLIGHT_FAILED', check.errors);
    const profile = await getProfile(profileId);
    const mode = profile.boot_mode;
    const effectiveOrigin = mode === 'pxe' ? profile.asset_url : null;
    if (profile.revision !== revision) throw coded('OKD generation preflight failed.', 'PREFLIGHT_FAILED', [{ field: 'revision', message: 'Save or reload the changed profile before generation.' }]);
    const pullSecret = await secretService.resolve();
    const installer = await getVerifiedInstaller();
    const oc = await getVerifiedOc();
    const sshPublicKey = profile.ssh_public_key || await keyService.ensureSshPublicKey(profile.id);
    const mediaVersion = await allocateVersion(profile);
    const id = `${profile.id}--${profile.release}--${mediaVersion}`;
    const profileRoot = path.join(workspacesRoot, profile.id, profile.release);
    const workspace = path.join(profileRoot, mediaVersion);
    const record = {
      id, profileId: profile.id, profileRevision: profile.revision, mediaVersion, state: 'queued', createdAt: now(),
      startedAt: null, finishedAt: null, release: profile.release,
      releaseImage: profiles.COMPATIBILITY_RECORD.releaseImage, releaseDigest: profiles.COMPATIBILITY_RECORD.releaseDigest,
      compatibilityRevision: profiles.COMPATIBILITY_RECORD.revision,
      installerArchiveSha256: installer.metadata.archiveSha256,
      installerBinarySha256: installer.metadata.binarySha256,
      mode, destinationUrl: mode === 'pxe' ? `${effectiveOrigin}okd/${profile.id}/${profile.release}/${mediaVersion}/` : null, versionId: null, errorCode: null,
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
      installConfig.sshKey = sshPublicKey;
      const agentConfig = yaml.load(templates.agentConfig, { schema: yaml.JSON_SCHEMA });
      if (mode === 'pxe') agentConfig.bootArtifactsBaseURL = `${effectiveOrigin}okd/${profile.id}/${profile.release}/${mediaVersion}`;
      else delete agentConfig.bootArtifactsBaseURL;
      await Promise.all([
        writeJobFile(path.join(workspace, 'install-config.yaml'), yaml.dump(installConfig, { noRefs: true, lineWidth: -1, sortKeys: false }), { flag: 'wx', mode: 0o600 }),
        writeJobFile(path.join(workspace, 'agent-config.yaml'), yaml.dump(agentConfig, { noRefs: true, lineWidth: -1, sortKeys: false }), { flag: 'wx', mode: 0o600 }),
      ]);
      await writeJobFile(logFile, '', { flag: 'wx', mode: 0o600 });
      await atomicRecord(record);
      try {
        child = spawnProcess(installer.path, ['agent', 'create', mode === 'iso' ? 'image' : 'pxe-files', '--dir', workspace], {
          cwd: workspace, env: { ...installerEnv(workspace), PATH: `${path.dirname(oc.path)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}` }, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
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
               const version = await finalizeArtifacts({ workspace, profile, job: record, mode, publicBaseUrl: effectiveOrigin });
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
        await releaseGenerationLock(generationLock).catch(() => {});
        await audit('generation.result', record.state === 'succeeded' ? 'succeeded' : record.state, {
          profileId: record.profileId, release: record.release, mediaVersion: record.mediaVersion, mode: record.mode,
        }).catch(() => {});
        if (active === running) active = null;
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

  async function start(request) {
    if (starting || active) return Promise.reject(coded('Another generation job is active on this instance.', 'JOB_ACTIVE'));
    starting = true;
    startingProfileId = request && request.profileId;
    let generationLock;
    try {
      generationLock = await acquireGenerationLock();
      return await startUnlocked(request, generationLock);
    } catch (err) {
      await releaseGenerationLock(generationLock).catch(() => {});
      throw err;
    } finally { starting = false; startingProfileId = null; }
  }

  async function cancel(identity) {
    await initialize();
    if (!identity || !active || active.record.profileId !== identity.profileId || active.record.release !== identity.release || active.record.mediaVersion !== identity.mediaVersion || !active.child) throw coded('That installer process is not active on this application instance.', 'NOT_ACTIVE');
    const running = active;
    const pid = running.child.pid;
    running.record.state = 'cancelling'; running.record.message = 'Cancellation requested.';
    await atomicRecord(running.record);
    try { killGroup(pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    let timer;
    try {
      await Promise.race([
        running.finished,
        new Promise((resolve, reject) => { timer = setTimeout(() => {
          if (active === running && running.child) { try { killGroup(pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') { reject(err); return; } } }
          resolve();
        }, cancelTimeoutMs); }),
      ]);
      // The exit handler persists the terminal state before resolving, so wait
      // for it rather than returning a stale "cancelling" record.
      await running.finished;
    } finally { clearTimeout(timer); }
    return running.record;
  }

  async function status(profileId) {
    await initialize();
    const history = (await readRecords()).filter((record) => !profileId || record.profileId === profileId).slice(0, 50);
    const current = active && (!profileId || active.record.profileId === profileId)
      ? { ...publicRecord(active.record), cancellable: !!active.child } : null;
    const blocking = active && profileId && active.record.profileId !== profileId
      ? { profileId: active.record.profileId, release: active.record.release, mediaVersion: active.record.mediaVersion, state: active.record.state, mode: active.record.mode } : null;
    return { current, blocking, history };
  }

  function isProfileActive(profileId) {
    return startingProfileId === profileId || !!(active && active.record.profileId === profileId);
  }

  function isActive() { return starting || !!active; }
  function setAuditSink(sink) { audit = typeof sink === 'function' ? sink : async () => {}; }

  async function readLog(identity, maxBytes = READ_LIMIT) {
    await initialize();
    if (!identity || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.profileId || '') || identity.release !== profiles.COMPATIBILITY_RECORD.release || !/^v[1-9][0-9]*$/.test(identity.mediaVersion || '')) throw coded('Invalid generation identity.', 'BAD_REQUEST');
    const id = `${identity.profileId}--${identity.release}--${identity.mediaVersion}`;
    const limit = Math.min(READ_LIMIT, Math.max(1, Number(maxBytes) || READ_LIMIT));
    const file = path.join(logRoot, `${id}.log`);
    let handle;
    try {
      const opened = await require('./safeFile').openRegular(file); handle = opened.handle;
      const stat = opened.stat;
      if (!stat.isFile() || stat.nlink !== 1) throw coded('Job log is unsafe.', 'UNSAFE_PATH');
      const length = Math.min(limit, stat.size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return { profileId: identity.profileId, release: identity.release, mediaVersion: identity.mediaVersion, text: buffer.toString('utf8'), truncated: stat.size > length };
    } catch (err) {
      if (err.code === 'ENOENT') throw coded('Job log not found.', 'NOT_FOUND');
      if (err.code === 'BAD_REQUEST' || err.code === 'UNSAFE_PATH') throw err;
      throw coded('Job log is unsafe.', 'UNSAFE_PATH');
    } finally { if (handle) await handle.close(); }
  }

  return { initialize, preflight, start, cancel, status, readLog, isProfileActive, isActive, setAuditSink };
}

const service = createJobService();
module.exports = { createJobService, renderConfigs, makeRedactor, initialize: service.initialize, preflight: service.preflight, startJob: service.start, cancelJob: service.cancel, getJobStatus: service.status, readJobLog: service.readLog, isProfileActive: service.isProfileActive, isActive: service.isActive, setAuditSink: service.setAuditSink };
