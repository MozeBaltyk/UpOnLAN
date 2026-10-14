'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const { execFile, spawn } = require('child_process');

// BlockList uses Node's native IP parser, including hexadecimal IPv4-mapped IPv6.
const probeBlocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 3]]) probeBlocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['::1', 128], ['fe80::', 10], ['ff00::', 8]]) probeBlocked.addSubnet(address, prefix, 'ipv6');
function allowedProbeAddress(address) {
  const family = net.isIP(address);
  return !!family && !probeBlocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const ID = /^[0-9a-f-]{16,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIVE_MONITOR = new Set(['starting', 'running', 'cancelling']);
const TERMINAL_JOB = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const LOG_LIMIT = 256 * 1024;
const READ_LIMIT = 64 * 1024;
const TRAVERSAL_LIMIT = 10000;
const AUDIT_LIMIT = 256 * 1024;
const AUDIT_ACTIONS = new Set([
  'profile.save', 'profile.delete', 'tool.install.request', 'tool.install.result',
  'generation.start', 'generation.cancel', 'generation.result',
  'version.publish', 'version.unpublish', 'version.activate', 'version.delete',
  'monitor.start', 'monitor.cancel', 'monitor.result', 'retention.cleanup',
  'pull-secret.save',
]);

function coded(message, code) { return Object.assign(new Error(message), { code }); }
function lstat(target) { return fs.promises.lstat(target).catch((err) => { if (err.code === 'ENOENT') return null; throw err; }); }
function exactRequest(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw coded('Invalid operations request.', 'BAD_REQUEST');
}
function safeOutcome(value) { return ['requested', 'succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out', 'accepted'].includes(value) ? value : 'failed'; }
function safeError(err, type) {
  if (err && err.code === 'PROBE_TIMEOUT') return 'timeout';
  if (err && err.code === 'PROBE_ADDRESS_BLOCKED') return 'address_blocked';
  if (type === 'dns' && ['ENOTFOUND', 'ENODATA'].includes(err && err.code)) return 'not_found';
  if (err && err.code === 'EAI_AGAIN') return 'temporary';
  if (err && err.code === 'ECONNREFUSED') return 'refused';
  if (err && ['EHOSTUNREACH', 'ENETUNREACH'].includes(err.code)) return 'unreachable';
  return 'network_error';
}
function cleanText(value, privateValue = '') {
  let text = String(value || '');
  if (privateValue) text = text.split(privateValue).join('[PRIVATE]');
  return text
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/((?:password|token|credential|authorization|auth|client[-_ ]?(?:key|certificate)[-_ ]?data)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/_=-]{80,}\b/g, '[REDACTED]');
}
function runFile(command, args, options) {
  return new Promise((resolve, reject) => execFile(command, args, options, (err, stdout, stderr) => (
    err ? reject(err) : resolve({ stdout, stderr })
  )));
}
function toolEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function createOperationsService({
  configRoot = process.env.UPONLAN_CONFIG || '/config',
  assetsRoot = process.env.UPONLAN_ASSETS || '/assets',
  logsRoot = process.env.UPONLAN_LOGS || '/logs',
  publicBaseUrl = process.env.OKD_PUBLIC_BASE_URL || '',
  persistenceReady = process.env.OKD_PERSISTENCE_READY === 'true',
  retentionDays = process.env.OKD_RETENTION_DAYS || '0',
  record,
  getProfile,
  listProfiles,
  listVersions,
  getToolStatus,
  getVerifiedInstaller,
  getVerifiedOc,
  isGenerationActive = () => false,
  romManifestIdentity = () => null,
  spawnProcess = spawn,
  execProcess = runFile,
  lookup = (hostname) => dns.promises.lookup(hostname),
  connect = (options) => net.connect(options),
  killGroup = (pid, signal) => process.kill(-pid, signal),
  now = () => new Date().toISOString(),
  monotonic = () => Date.now(),
  probeTimeoutMs = 2000,
  monitorTimeoutMs = 24 * 60 * 60 * 1000,
  cancelTimeoutMs = 30000,
  auditMaxBytes = AUDIT_LIMIT,
  renameMonitorRecord = fs.promises.rename,
} = {}) {
  const okdConfig = path.join(configRoot, 'okd');
  const jobsRoot = path.join(okdConfig, 'jobs');
  const workspacesRoot = path.join(okdConfig, 'workspaces');
  const publicationsRoot = path.join(okdConfig, 'publications');
  const profilesRoot = path.join(okdConfig, 'profiles');
  const versionsRoot = path.join(assetsRoot, 'okd');
  const logRoot = path.join(logsRoot, 'okd');
  const monitorFile = path.join(okdConfig, 'monitor.json');
  const monitorLog = path.join(logRoot, 'monitor.log');
  const auditFile = path.join(logRoot, 'audit.jsonl');
  let active = null;
  let starting = false;
  let initialized;
  let monitorRecord = null;
  let auditMutation = Promise.resolve();

  async function openSecure(file, flags) {
    let handle;
    try {
      handle = await fs.promises.open(file, flags | fs.constants.O_NOFOLLOW, 0o600);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw coded('OKD log is unsafe.', 'UNSAFE_PATH');
      await handle.chmod(0o600);
      return { handle, stat };
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (err.code === 'ELOOP') throw coded('OKD log is unsafe.', 'UNSAFE_PATH');
      throw err;
    }
  }

  async function safeRoot(root, target, create = false) {
    const base = path.resolve(root); const resolved = path.resolve(target);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
    if (create) await fs.promises.mkdir(base, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(base);
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
    let current = base;
    for (const part of path.relative(base, resolved).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw coded('OKD storage path is unsafe.', 'UNSAFE_PATH');
    }
    return resolved;
  }

  function publicMonitor(value = monitorRecord) {
    if (!value) return null;
    return {
      profileId: SLUG.test(value.profileId || '') ? value.profileId : null,
      versionId: ID.test(value.versionId || '') ? value.versionId : null,
      jobId: ID.test(value.jobId || '') ? value.jobId : null,
      state: ['starting', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out', 'persistence_failed'].includes(value.state) ? value.state : 'failed',
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
      finishedAt: typeof value.finishedAt === 'string' ? value.finishedAt : null,
      message: cleanText(value.message).slice(0, 300),
      cancellable: !!(active && active.child),
    };
  }

  async function atomicJson(file, value) {
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try { await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await renameMonitorRecord(temp, file); }
    finally { await fs.promises.rm(temp, { force: true }); }
  }

  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      await fs.promises.mkdir(okdConfig, { recursive: true, mode: 0o700 });
      await fs.promises.mkdir(logRoot, { recursive: true, mode: 0o700 });
      await safeRoot(configRoot, okdConfig); await safeRoot(logsRoot, logRoot);
      const stat = await lstat(monitorFile);
      if (stat) {
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw coded('Monitor state is unsafe.', 'UNSAFE_PATH');
        try { monitorRecord = publicMonitor(JSON.parse(await fs.promises.readFile(monitorFile, 'utf8'))); } catch { monitorRecord = null; }
      }
      if (monitorRecord && ACTIVE_MONITOR.has(monitorRecord.state)) {
        monitorRecord.state = 'interrupted'; monitorRecord.finishedAt = now(); monitorRecord.message = 'Monitoring was interrupted by an application restart.';
        await atomicJson(monitorFile, publicMonitor(monitorRecord));
      }
    })();
    return initialized;
  }

  async function audit(action, outcome, refs = {}) {
    if (!AUDIT_ACTIONS.has(action)) return;
    const event = { timestamp: now(), action, outcome: safeOutcome(outcome) };
    if (SLUG.test(refs.profileId || '')) event.profileId = refs.profileId;
    if (ID.test(refs.versionId || '')) event.versionId = refs.versionId;
    if (ID.test(refs.jobId || '')) event.jobId = refs.jobId;
    if (['pxe', 'iso'].includes(refs.mode)) event.mode = refs.mode;
    if (['internal', 'external'].includes(refs.source)) event.source = refs.source;
    const write = async () => {
      await initialize();
      let opened = await openSecure(auditFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
      if (opened.stat.size >= auditMaxBytes) {
        await opened.handle.close(); opened = null;
        const rotated = `${auditFile}.1`;
        const rotatedStat = await lstat(rotated);
        if (rotatedStat) {
          const old = await openSecure(rotated, fs.constants.O_RDONLY);
          await old.handle.close();
        }
        await fs.promises.rm(rotated, { force: true });
        await fs.promises.rename(auditFile, rotated);
        await fs.promises.chmod(rotated, 0o600);
        opened = await openSecure(auditFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
      }
      try { await opened.handle.writeFile(`${JSON.stringify(event)}\n`); }
      finally { await opened.handle.close(); }
    };
    const next = auditMutation.then(write, write); auditMutation = next.catch(() => {}); return next;
  }

  async function readJob(profileId, jobId) {
    if (!SLUG.test(profileId || '') || !ID.test(jobId || '')) throw coded('Invalid profile or job identity.', 'BAD_REQUEST');
    const file = path.join(jobsRoot, `${jobId}.json`);
    let handle;
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw coded('Job record is unsafe.', 'UNSAFE_PATH');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (value.id !== jobId || value.profileId !== profileId) throw coded('Job identity does not match.', 'INVALID_MANIFEST');
      return value;
    } catch (err) {
      if (err.code === 'ENOENT') throw coded('Generation job not found.', 'NOT_FOUND');
      if (err instanceof SyntaxError) throw coded('Generation job is invalid.', 'INVALID_MANIFEST');
      throw err;
    } finally { if (handle) await handle.close(); }
  }

  async function selection(request) {
    exactRequest(request, ['profileId', 'versionId']);
    if (!SLUG.test(request.profileId || '') || !ID.test(request.versionId || '')) throw coded('Invalid profile or version identity.', 'BAD_REQUEST');
    const profile = await getProfile(request.profileId);
    const version = (await listVersions(profile.id)).find((item) => item.versionId === request.versionId);
    if (!version || version.jobId !== request.versionId || version.release !== record.release) throw coded('Successful artifact version not found.', 'NOT_FOUND');
    if (profile.revision !== version.profileRevision) throw coded('Selected version differs from the current profile revision. Restore its original profile/templates before operations; do not probe a different cluster.', 'STALE_REVISION');
    const job = await readJob(profile.id, version.jobId);
    if (job.state !== 'succeeded' || job.versionId !== version.versionId || job.profileRevision !== version.profileRevision) throw coded('Version is not backed by a successful generation job.', 'INVALID_MANIFEST');
    const profileRoot = path.join(workspacesRoot, profile.id);
    const workspace = path.join(profileRoot, job.id);
    await safeRoot(workspacesRoot, profileRoot); await safeRoot(workspacesRoot, workspace);
    return { profile, version, job, workspace };
  }

  async function appendMonitor(handle, text, state, workspace) {
    if (!text || state.bytes >= LOG_LIMIT) return;
    const clean = Buffer.from(cleanText(text, workspace));
    const chunk = clean.subarray(0, LOG_LIMIT - state.bytes);
    await handle.write(chunk); state.bytes += chunk.length;
  }

  async function startMonitor(request) {
    await initialize();
    if (starting || active) throw coded('A monitor is already active on this instance.', 'MONITOR_ACTIVE');
    if (isGenerationActive()) throw coded('Monitoring is blocked while generation is active.', 'OPERATION_ACTIVE');
    starting = true;
    try {
      const selected = await selection(request);
      const installer = await getVerifiedInstaller();
      const command = record.commands && record.commands.monitor;
      if (!Array.isArray(command) || command.join('\0') !== ['agent', 'wait-for', 'install-complete', '--dir'].join('\0')) throw coded('The release monitoring command is not supported.', 'MONITOR_UNSUPPORTED');
      monitorRecord = { profileId: selected.profile.id, versionId: selected.version.versionId, jobId: selected.job.id, state: 'starting', startedAt: now(), finishedAt: null, message: 'Monitoring is starting.' };
      const log = await openSecure(monitorLog, fs.constants.O_WRONLY | fs.constants.O_CREAT);
      await log.handle.truncate(0);
      try { await atomicJson(monitorFile, publicMonitor(monitorRecord)); }
      catch (err) { await log.handle.close().catch(() => {}); throw err; }
      const env = toolEnv();
      let child;
      try { child = spawnProcess(installer.path, [...command, selected.workspace], { cwd: selected.workspace, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { await log.handle.close().catch(() => {}); monitorRecord.state = 'failed'; monitorRecord.finishedAt = now(); monitorRecord.message = 'Monitor could not be started.'; await atomicJson(monitorFile, publicMonitor(monitorRecord)); throw coded(monitorRecord.message, 'SPAWN_FAILED'); }
      const logState = { bytes: 0 }; let logChain = Promise.resolve(); let settled = false; let resolveFinished; let startupPersistenceFailed = false;
      const { makeRedactor } = require('./okdJobServices');
      const redactors = [makeRedactor('', {}, [selected.workspace]), makeRedactor('', {}, [selected.workspace])];
      const finished = new Promise((resolve) => { resolveFinished = resolve; });
      const consume = (redactor) => (chunk) => { logChain = logChain.then(() => appendMonitor(log.handle, redactor.feed(chunk), logState, selected.workspace)).catch(() => {}); };
      const running = { child, finished, log: log.handle, timeout: null, killTimer: null };
      active = running;
      if (child.stdout) child.stdout.on('data', consume(redactors[0])); if (child.stderr) child.stderr.on('data', consume(redactors[1]));
      let setupResolve; const setupComplete = new Promise((resolve) => { setupResolve = resolve; });
      const finish = async (code, signal, spawnError) => {
        if (settled) return; settled = true;
        await setupComplete;
        try {
          running.child = null; await logChain;
          for (const redactor of redactors) await appendMonitor(log.handle, redactor.flush(), logState, selected.workspace);
          await log.handle.close().catch(() => {});
          if (!startupPersistenceFailed) {
            if (monitorRecord.state === 'cancelling') { monitorRecord.state = 'cancelled'; monitorRecord.message = 'Monitoring cancelled.'; }
            else if (monitorRecord.state === 'timed_out') monitorRecord.message = 'Monitoring reached its time limit.';
            else if (!spawnError && code === 0) { monitorRecord.state = 'succeeded'; monitorRecord.message = 'Installation completed.'; }
            else { monitorRecord.state = 'failed'; monitorRecord.message = signal ? 'Monitoring was terminated unexpectedly.' : 'Installation monitoring failed.'; }
          }
          monitorRecord.finishedAt = now();
          try { await atomicJson(monitorFile, publicMonitor(monitorRecord)); }
          catch {
            monitorRecord.state = 'persistence_failed'; monitorRecord.message = 'Monitor state could not be persisted safely.';
            await atomicJson(monitorFile, publicMonitor(monitorRecord)).catch(() => {});
          }
        } finally {
          clearTimeout(running.timeout); clearTimeout(running.killTimer);
          if (active === running) active = null;
          resolveFinished(publicMonitor(monitorRecord));
          await audit('monitor.result', monitorRecord.state, monitorRecord).catch(() => {});
        }
      };
      child.once('error', () => { finish(null, null, true).catch(() => {}); });
      child.once('close', (code, signal) => { finish(code, signal, false).catch(() => {}); });
      running.timeout = setTimeout(() => {
        if (!running.child) return;
        monitorRecord.state = 'timed_out';
        try { killGroup(running.child.pid, 'SIGTERM'); } catch { /* close/error determines terminal state */ }
        running.killTimer = setTimeout(() => { if (running.child) try { killGroup(running.child.pid, 'SIGKILL'); } catch { /* already exited */ } }, cancelTimeoutMs);
        running.killTimer.unref();
      }, monitorTimeoutMs); running.timeout.unref();
      monitorRecord.state = 'running'; monitorRecord.message = 'Installer monitoring is running.';
      try { await atomicJson(monitorFile, publicMonitor(monitorRecord)); setupResolve(); }
      catch {
        startupPersistenceFailed = true; monitorRecord.state = 'failed'; monitorRecord.message = 'Monitor state could not be persisted safely.'; setupResolve();
        try { killGroup(child.pid, 'SIGTERM'); } catch { /* bounded KILL remains */ }
        running.killTimer = setTimeout(() => { if (running.child) try { killGroup(child.pid, 'SIGKILL'); } catch { /* already exited */ } }, cancelTimeoutMs); running.killTimer.unref();
        throw coded(monitorRecord.message, 'PERSISTENCE_FAILED');
      }
      return publicMonitor(monitorRecord);
    } finally { starting = false; }
  }

  async function cancelMonitor() {
    await initialize();
    if (!active || !active.child) throw coded('No monitor is active on this instance.', 'NOT_ACTIVE');
    const running = active; const pid = running.child.pid;
    monitorRecord.state = 'cancelling'; monitorRecord.message = 'Monitoring cancellation requested.'; await atomicJson(monitorFile, publicMonitor(monitorRecord));
    try { killGroup(pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    let timer;
    await Promise.race([running.finished, new Promise((resolve, reject) => { timer = setTimeout(() => {
      if (active === running && running.child) try { killGroup(pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') { reject(err); return; } }
      resolve();
    }, cancelTimeoutMs); })]).finally(() => clearTimeout(timer));
    return publicMonitor(monitorRecord);
  }

  async function monitorStatus() { await initialize(); return publicMonitor(); }
  function isMonitorActive() { return starting || !!active; }
  async function readMonitorLog() {
    await initialize(); let handle;
    try {
      handle = await fs.promises.open(monitorLog, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw coded('Monitor log is unsafe.', 'UNSAFE_PATH');
      const length = Math.min(READ_LIMIT, stat.size); const buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return { text: cleanText(buffer.toString('utf8')), truncated: stat.size > length };
    } catch (err) { if (err.code === 'ENOENT') return { text: '', truncated: false }; throw err; }
    finally { if (handle) await handle.close(); }
  }

  async function health(request) {
    const selected = await selection(request);
    const authDir = path.join(selected.workspace, 'auth'); const kubeconfig = path.join(authDir, 'kubeconfig');
    const authStat = await lstat(authDir);
    if (!authStat) return { ready: false, reason: 'kubeconfig_not_ready', capturedAt: now() };
    if (authStat.isSymbolicLink() || !authStat.isDirectory()) throw coded('Cluster credential directory is unsafe.', 'UNSAFE_PATH');
    const configStat = await lstat(kubeconfig);
    if (!configStat) return { ready: false, reason: 'kubeconfig_not_ready', capturedAt: now() };
    if (configStat.isSymbolicLink() || !configStat.isFile() || configStat.nlink !== 1) throw coded('Cluster credential file is unsafe.', 'UNSAFE_PATH');
    let oc; try { oc = await getVerifiedOc(); } catch { return { ready: false, reason: 'oc_not_ready', capturedAt: now() }; }
    const env = toolEnv({ KUBECONFIG: kubeconfig });
    try {
      const [nodesRaw, operatorsRaw] = await Promise.all([
        execProcess(oc.path, ['get', 'nodes', '-o=json'], { env, timeout: 15000, maxBuffer: 2 * 1024 * 1024, shell: false }),
        execProcess(oc.path, ['get', 'clusteroperators.config.openshift.io', '-o=json'], { env, timeout: 15000, maxBuffer: 2 * 1024 * 1024, shell: false }),
      ]);
      const nodes = JSON.parse(nodesRaw.stdout); const operators = JSON.parse(operatorsRaw.stdout);
      if (!Array.isArray(nodes.items) || !Array.isArray(operators.items) || nodes.items.length > 10000 || operators.items.length > 10000) throw new Error('invalid');
      const nodeReady = nodes.items.filter((item) => (item.status && item.status.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True')).length;
      const conditionCount = (type) => operators.items.filter((item) => (item.status && item.status.conditions || []).some((c) => c.type === type && c.status === 'True')).length;
      const expectedNodes = selected.profile.hosts.length;
      const expectedOperators = ['authentication', 'etcd', 'ingress', 'kube-apiserver', 'network', 'openshift-apiserver'];
      const operatorReady = (item) => ['Available', 'Progressing', 'Degraded'].every((type) => (item.status && item.status.conditions || []).some((c) => c.type === type && c.status === (type === 'Available' ? 'True' : 'False')));
      const ready = expectedNodes > 0 && nodes.items.length === expectedNodes && nodeReady === expectedNodes
        && expectedOperators.every((name) => operators.items.some((item) => item.metadata && item.metadata.name === name && operatorReady(item)))
        && operators.items.every(operatorReady);
      return { ready, querySucceeded: true, reason: ready ? null : 'cluster_not_ready', capturedAt: now(), nodes: { total: nodes.items.length, ready: nodeReady, expected: expectedNodes }, operators: { total: operators.items.length, available: conditionCount('Available'), progressing: conditionCount('Progressing'), degraded: conditionCount('Degraded') } };
    } catch { return { ready: false, reason: 'query_failed', capturedAt: now() }; }
  }

  async function timedProbe(work, timeoutMs = probeTimeoutMs) {
    let timer; return Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' })), timeoutMs); })]).finally(() => clearTimeout(timer));
  }
  async function resolveProbe(hostname) {
    const started = monotonic();
    try {
      const answer = await timedProbe(() => lookup(hostname, { all: true, verbatim: true }));
      const values = (Array.isArray(answer) ? answer : [answer]).map((item) => item && item.address).filter((address) => net.isIP(address));
      // Fail the name closed on mixed safe/unsafe answers, rather than selecting a bypass.
      if (values.some((address) => !allowedProbeAddress(address))) throw coded('Probe destination is blocked.', 'PROBE_ADDRESS_BLOCKED');
      const addresses = [...new Set(values)].slice(0, 8);
      if (!addresses.length) throw Object.assign(new Error('no address'), { code: 'ENODATA' });
      return { addresses, result: { hostname, probe: 'dns', success: true, durationMs: Math.max(0, monotonic() - started) } };
    } catch (err) {
      return { addresses: [], result: { hostname, probe: 'dns', success: false, durationMs: Math.max(0, monotonic() - started), error: safeError(err, 'dns') } };
    }
  }
  async function tcpProbe(hostname, port, addresses, dnsResult) {
    const started = monotonic(); let socket;
    if (!addresses.length) return { hostname, probe: 'tcp', port, success: false, durationMs: 0, error: dnsResult.error || 'not_found' };
    try {
      await timedProbe(() => new Promise((resolve, reject) => {
        const address = addresses[0];
        if (!allowedProbeAddress(address)) { reject(coded('Probe destination is blocked.', 'PROBE_ADDRESS_BLOCKED')); return; }
        socket = connect({ host: address, port, family: net.isIP(address) });
        socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject);
      }));
      return { hostname, probe: 'tcp', port, success: true, durationMs: Math.max(0, monotonic() - started) };
    } catch (err) { if (socket) socket.destroy(); return { hostname, probe: 'tcp', port, success: false, durationMs: Math.max(0, monotonic() - started), error: safeError(err, 'tcp') }; }
  }
  async function probes(request) {
    const { profile } = await selection(request);
    let publicHost; let publicPort;
    try { const url = new URL(publicBaseUrl); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(); publicHost = url.hostname; publicPort = url.port ? Number(url.port) : 443; }
    catch { throw coded('The public OKD origin is not configured safely.', 'PUBLIC_URL_INVALID'); }
    const suffix = `${profile.cluster_name}.${profile.base_domain}`;
    const hosts = [`api.${suffix}`, `api-int.${suffix}`, `console-openshift-console.apps.${suffix}`, publicHost];
    const tcp = [[hosts[0], 6443], [hosts[1], 22623], [hosts[2], 443], [publicHost, publicPort]];
    const resolved = new Map(await Promise.all([...new Set(hosts)].map(async (host) => [host, await resolveProbe(host)])));
    return { ranAt: now(), vantage: 'UpOnLAN server namespace; DNS and first resolved address TCP only, not target-node/TLS/HTTP readiness', results: [...resolved.values()].map((item) => item.result).concat(await Promise.all(tcp.map(([host, port]) => {
      const item = resolved.get(host); return tcpProbe(host, port, item.addresses, item.result);
    }))) };
  }

  async function scan(root, rejectSymlinks = false) {
    const result = { count: 0, bytes: 0, oldest: null, newest: null, truncated: false };
    const rootStat = await lstat(root); if (!rootStat) return result;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw coded('OKD storage root is unsafe.', 'UNSAFE_PATH');
    const queue = [root]; let visited = 0;
    while (queue.length) {
      const dir = queue.shift();
      for (const name of await fs.promises.readdir(dir)) {
        if (++visited > TRAVERSAL_LIMIT) { result.truncated = true; return result; }
        const target = path.join(dir, name); const stat = await fs.promises.lstat(target);
        if (stat.isSymbolicLink()) { if (rejectSymlinks) throw coded('Retention target contains a symbolic link.', 'UNSAFE_PATH'); continue; }
        result.count += 1; if (stat.isFile()) result.bytes += stat.size; const stamp = stat.mtime.toISOString();
        if (!result.oldest || stamp < result.oldest) result.oldest = stamp; if (!result.newest || stamp > result.newest) result.newest = stamp;
        if (stat.isDirectory()) queue.push(target);
      }
    }
    return result;
  }

  function retentionNumber() { const value = Number(retentionDays); return Number.isFinite(value) && value > 0 ? Math.min(36500, Math.floor(value)) : 0; }
  function validTerminalJob(job, stem) {
    const keys = ['id', 'profileId', 'profileRevision', 'state', 'createdAt', 'startedAt', 'finishedAt', 'release', 'releaseImage', 'releaseDigest', 'compatibilityRevision', 'installerArchiveSha256', 'installerBinarySha256', 'mode', 'versionId', 'errorCode', 'log', 'message'];
    return job && typeof job === 'object' && !Array.isArray(job) && Object.keys(job).filter((key) => key !== 'context').sort().join('\0') === keys.sort().join('\0')
      && job.id === stem && ID.test(job.id) && SLUG.test(job.profileId || '') && SHA256.test(job.profileRevision || '')
      && TERMINAL_JOB.has(job.state) && typeof job.createdAt === 'string' && Number.isFinite(Date.parse(job.createdAt))
      && (job.startedAt === null || (typeof job.startedAt === 'string' && Number.isFinite(Date.parse(job.startedAt))))
      && typeof job.finishedAt === 'string' && Number.isFinite(Date.parse(job.finishedAt))
      && job.release === record.release && job.releaseImage === record.releaseImage && job.releaseDigest === record.releaseDigest
      && job.compatibilityRevision === record.revision && SHA256.test(job.installerArchiveSha256 || '') && SHA256.test(job.installerBinarySha256 || '')
      && ['pxe', 'iso'].includes(job.mode) && (job.versionId === null || ID.test(job.versionId || ''))
      && (job.errorCode === null || ['ARTIFACT_FINALIZATION_FAILED', 'PERSISTENCE_FAILED'].includes(job.errorCode))
      && job.log === `${job.id}.log` && typeof job.message === 'string' && job.message.length <= 500;
  }
  async function activeVersionIds() {
    const ids = new Set(); const stat = await lstat(publicationsRoot); if (!stat) return ids;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded('Publication storage is unsafe.', 'UNSAFE_PATH');
    for (const name of (await fs.promises.readdir(publicationsRoot)).slice(0, TRAVERSAL_LIMIT)) {
      if (!/^[a-z0-9-]+\.json$/.test(name)) continue;
      const file = path.join(publicationsRoot, name); const fileStat = await fs.promises.lstat(file); if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw coded('Publication pointer is unsafe.', 'UNSAFE_PATH');
      try { const value = JSON.parse(await fs.promises.readFile(file, 'utf8')); if (ID.test(value.versionId || '')) ids.add(value.versionId); } catch { throw coded('Publication pointer is invalid.', 'INVALID_PUBLICATION'); }
    }
    return ids;
  }
  async function candidates() {
    const days = retentionNumber(); const result = { enabled: days > 0, days, count: 0, workspaceBytes: 0, logBytes: 0, blockedByPublication: 0, protectedInstallations: 0, entries: [] };
    if (!days) return result; const cutoff = Date.now() - days * 86400000; const activeIds = await activeVersionIds();
    const stat = await lstat(jobsRoot); if (!stat) return result; if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded('Job storage is unsafe.', 'UNSAFE_PATH');
    for (const name of (await fs.promises.readdir(jobsRoot)).slice(0, TRAVERSAL_LIMIT)) {
      if (!/^([0-9a-f-]{16,64})\.json$/.test(name)) continue;
      const jobFile = path.join(jobsRoot, name); const jobStat = await fs.promises.lstat(jobFile);
      if (jobStat.isSymbolicLink() || !jobStat.isFile() || jobStat.nlink !== 1 || jobStat.size > 64 * 1024) throw coded('Job record is unsafe.', 'UNSAFE_PATH');
      let job; try { job = JSON.parse(await fs.promises.readFile(jobFile, 'utf8')); } catch { continue; }
      const stem = name.slice(0, -5);
      const finished = Date.parse(job.finishedAt);
      if (!validTerminalJob(job, stem) || finished >= cutoff) continue;
      if (activeIds.has(job.id) || activeIds.has(job.versionId)) { result.blockedByPublication += 1; continue; }
      // ponytail: no retirement database; successful media/auth remain protected indefinitely.
      if (job.state === 'succeeded' || job.versionId || (monitorRecord && monitorRecord.jobId === job.id)
        || await lstat(path.join(versionsRoot, job.profileId, job.id))) { result.protectedInstallations += 1; continue; }
      const workspace = path.join(workspacesRoot, job.profileId, job.id); const log = path.join(logRoot, `${job.id}.log`);
      if (await lstat(workspace)) await safeRoot(workspacesRoot, workspace);
      const workspaceScan = await scan(workspace); const logStat = await lstat(log);
      if (logStat && (logStat.isSymbolicLink() || !logStat.isFile() || logStat.nlink !== 1)) throw coded('Job log is unsafe.', 'UNSAFE_PATH');
      result.count += 1; result.workspaceBytes += workspaceScan.bytes; result.logBytes += logStat ? logStat.size : 0; result.entries.push({ workspace, log, hasWorkspace: !!await lstat(workspace), hasLog: !!logStat });
    }
    return result;
  }
  async function storageReport() {
    await initialize(); const retention = await candidates(); delete retention.entries;
    if (await lstat(versionsRoot)) await safeRoot(assetsRoot, versionsRoot);
    const artifactVersions = await scan(versionsRoot); artifactVersions.versions = 0;
    const versionsStat = await lstat(versionsRoot);
    if (versionsStat) for (const profileId of (await fs.promises.readdir(versionsRoot)).slice(0, TRAVERSAL_LIMIT)) {
      if (!SLUG.test(profileId)) continue; const profileDir = path.join(versionsRoot, profileId); const profileStat = await fs.promises.lstat(profileDir);
      if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) continue;
      for (const versionId of (await fs.promises.readdir(profileDir)).slice(0, TRAVERSAL_LIMIT)) if (ID.test(versionId)) {
        const stat = await fs.promises.lstat(path.join(profileDir, versionId)); if (!stat.isSymbolicLink() && stat.isDirectory()) artifactVersions.versions += 1;
      }
    }
    return { profiles: await scan(profilesRoot), jobs: await scan(jobsRoot), workspaces: await scan(workspacesRoot), logs: await scan(logRoot), artifactVersions, retention };
  }
  async function validateRemoval(target, root, directory) {
    const resolved = path.resolve(target); if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw coded('Retention target is unsafe.', 'UNSAFE_PATH');
    const stat = await lstat(resolved); if (!stat) return false;
    await safeRoot(root, directory ? resolved : path.dirname(resolved));
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1)) throw coded('Retention target is unsafe.', 'UNSAFE_PATH');
    if (directory) await scan(resolved, true); return true;
  }
  async function cleanup(request) {
    exactRequest(request, ['confirmed']); if (request.confirmed !== true) throw coded('Confirm cleanup of eligible private workspaces and logs.', 'CONFIRMATION_REQUIRED');
    if (isGenerationActive() || isMonitorActive()) throw coded('Cleanup is blocked while generation or monitoring is active.', 'OPERATION_ACTIVE');
    const found = await candidates(); if (!found.enabled) throw coded('Retention is disabled.', 'RETENTION_DISABLED');
    const approved = [];
    for (const entry of found.entries) approved.push({ ...entry, hasWorkspace: await validateRemoval(entry.workspace, workspacesRoot, true), hasLog: await validateRemoval(entry.log, logRoot, false) });
    if (isGenerationActive() || isMonitorActive()) throw coded('Cleanup is blocked while generation or monitoring is active.', 'OPERATION_ACTIVE');
    let workspaces = 0; let logs = 0;
    for (const entry of approved) { if (entry.hasWorkspace) { await fs.promises.rm(entry.workspace, { recursive: true }); workspaces += 1; } if (entry.hasLog) { await fs.promises.unlink(entry.log); logs += 1; } }
    return { jobsPreserved: approved.length, workspacesDeleted: workspaces, logsDeleted: logs };
  }

  async function diagnostics() {
    const [profileList, tools, storage, monitor] = await Promise.all([
      listProfiles().catch(() => []), getToolStatus(record.release).catch(() => null), storageReport(), monitorStatus(),
    ]);
    const publications = await activeVersionIds().catch(() => new Set());
    let publicUrlReady = false; try { const url = new URL(publicBaseUrl); publicUrlReady = url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { /* false */ }
    const rom = romManifestIdentity();
    return {
      configured: { authentication: !!process.env.WEBAPP_USER && !!process.env.WEBAPP_PASS, persistence: !!persistenceReady, publicBaseUrl: publicUrlReady },
      tools: { installer: !!(tools && tools.tools.installer.ready), oc: !!(tools && tools.tools.oc.ready) },
      active: { generation: !!isGenerationActive(), monitoring: !!isMonitorActive(), monitorState: monitor ? monitor.state : null },
      inventory: { profiles: profileList.length, publications: publications.size, versions: storage.artifactVersions.versions },
      romManifestReady: typeof rom === 'string' && !rom.startsWith('invalid:'), retention: storage.retention,
    };
  }

  return { initialize, audit, startMonitor, cancelMonitor, monitorStatus, readMonitorLog, isMonitorActive, health, probes, storageReport, cleanup, diagnostics };
}

const profiles = require('./okdServices');
const tools = require('./okdToolServices');
const artifacts = require('./okdArtifactServices');
const jobs = require('./okdJobServices');
const roms = require('./romBuildService');
const service = createOperationsService({
  record: profiles.COMPATIBILITY_RECORD, getProfile: profiles.getProfile, listProfiles: profiles.listProfiles,
  listVersions: artifacts.listVersions, getToolStatus: tools.getToolStatus, getVerifiedInstaller: tools.getVerifiedInstaller,
  getVerifiedOc: tools.getVerifiedOc, isGenerationActive: jobs.isActive, romManifestIdentity: roms.currentBootManifestIdentity,
});

module.exports = { createOperationsService, initialize: service.initialize, audit: service.audit, startMonitor: service.startMonitor, cancelMonitor: service.cancelMonitor, monitorStatus: service.monitorStatus, readMonitorLog: service.readMonitorLog, isMonitorActive: service.isMonitorActive, health: service.health, probes: service.probes, storageReport: service.storageReport, cleanup: service.cleanup, diagnostics: service.diagnostics };
