'use strict';
const okd = require('../services/okdServices');
const tools = require('../services/okdToolServices');
const jobs = require('../services/okdJobServices');
const artifacts = require('../services/okdArtifactServices');
const operations = require('../services/okdOperationsServices');
const pullSecrets = require('../services/okdPullSecretServices');

function createProfileJobCoordinator({ startJob, deleteProfile, isProfileActive }) {
  let mutation = Promise.resolve();
  const serialize = (fn) => {
    const next = mutation.then(fn, fn);
    mutation = next.catch(() => {});
    return next;
  };
  return {
    start: (request) => serialize(() => startJob(request)),
    delete: (id) => serialize(() => deleteProfile(id, () => isProfileActive(id))),
    run: (fn) => serialize(fn),
  };
}
const coordinator = createProfileJobCoordinator({
  startJob: jobs.startJob, deleteProfile: okd.deleteProfile, isProfileActive: jobs.isProfileActive,
});

function resultError(err) {
  const safeCodes = new Set([
    'ALREADY_EXISTS', 'BAD_REQUEST', 'CACHE_INVALID', 'CHECKSUM_MISMATCH', 'CONFIRMATION_REQUIRED',
    'DOWNLOAD_FAILED', 'EXECUTION_FAILED', 'HAS_ARTIFACTS', 'IMMUTABLE_ID', 'INSTALLER_NOT_READY', 'INVALID_ID',
    'INVALID_PROFILE', 'JOB_ACTIVE', 'NOT_ACTIVE', 'NOT_FOUND', 'PREFLIGHT_FAILED', 'PERSISTENCE_FAILED',
    'PULL_SECRET_INVALID', 'PULL_SECRET_UNAVAILABLE', 'SPAWN_FAILED', 'STALE_REVISION',
    'UNSAFE_ARCHIVE', 'UNSAFE_PATH', 'VALIDATION', 'VERSION_MISMATCH', 'INVALID_MANIFEST',
    'INVALID_PUBLICATION', 'ISO_NOT_PUBLISHABLE', 'PUBLIC_URL_INVALID', 'VERSION_ACTIVE', 'PROFILE_ACTIVE',
    'INVALID_MANIFEST', 'OC_NOT_READY', 'TEMPLATE_INVALID', 'AUTH_REQUIRED', 'EXTERNALLY_MANAGED', 'PERSISTENCE_REQUIRED',
    'SSH_KEY_CLEANUP_FAILED', 'SSH_KEY_GENERATION_FAILED', 'SSH_KEY_INVALID', 'CERTIFICATE_INVALID',
    'CERTIFICATE_PRIVATE_KEY', 'CERTIFICATE_NOT_CA', 'CERTIFICATE_CHAIN_INVALID', 'CERTIFICATE_CHAIN_LIMIT',
    'CERTIFICATE_DNS_FAILED', 'CERTIFICATE_ADDRESS_BLOCKED', 'CERTIFICATE_REBINDING', 'CERTIFICATE_TIMEOUT',
    'CERTIFICATE_CONNECT_FAILED', 'CERTIFICATE_MISMATCH', 'CERTIFICATE_CONFIRMATION_REQUIRED', 'VERSION_EXISTS',
  ]);
  const safe = safeCodes.has(err.code);
  return { ok: false, code: safe ? err.code : 'INTERNAL', message: safe ? err.message : 'OKD operation failed.', errors: safe ? (err.errors || []) : [] };
}

function registerOkdHandlers(socket, { toolService = tools } = {}) {
  const audit = (action, outcome, refs) => operations.audit(action, outcome, refs).catch(() => {});
  const mutate = async (action, refs, fn) => {
    try { const value = await fn(); await audit(action, 'succeeded', refs); return value; }
    catch (err) { await audit(action, 'failed', refs); throw err; }
  };
  function handle(fn, reply) {
    if (typeof reply !== 'function') return;
    Promise.resolve().then(fn).then((data) => reply({ ok: true, data })).catch((err) => reply(resultError(err)));
  }
  function exactRequest(request, keys, message) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !keys.includes(key))) {
      throw Object.assign(new Error(message), { code: 'BAD_REQUEST' });
    }
  }
  socket.on('okd:list', (reply) => handle(() => okd.listProfiles(), reply));
  socket.on('okd:get', (id, reply) => handle(() => okd.getProfile(id), reply));
  socket.on('okd:save', (request, reply) => handle(async () => {
    exactRequest(request, ['profile', 'existingId', 'expectedRevision'], 'Save request is invalid.');
    const prepared = await okd.prepareProfileTrust(request.profile);
    return mutate('profile.save', { profileId: prepared && prepared.id }, () => okd.saveProfile(
      prepared,
      request.existingId === undefined ? null : request.existingId,
      request.expectedRevision === undefined ? null : request.expectedRevision,
    )).then((saved) => {
      // Server-owned work survives disconnects; never await downloads in the save acknowledgement.
      Promise.resolve().then(() => toolService.installTools(saved.release)).catch(() => {});
      return saved;
    });
  }, reply));
  socket.on('okd:certificates:inspect', (request, reply) => handle(() => {
    exactRequest(request, ['assetUrl', 'storedPem', 'additionalPem'], 'Certificate inspection request is invalid.');
    return require('../services/assetCertificateServices').inspectEndpoint({ origin: request.assetUrl, storedPem: request.storedPem || '', additionalPem: request.additionalPem || '' });
  }, reply));
  socket.on('okd:certificates:validate', (request, reply) => handle(() => {
    exactRequest(request, ['pem'], 'Certificate validation request is invalid.');
    return require('../services/assetCertificateServices').parseBundle(request.pem);
  }, reply));
  socket.on('okd:certificates:confirm', (request, reply) => handle(async () => {
    exactRequest(request, ['profileId'], 'Certificate confirmation request is invalid.');
    await audit('certificate.confirm', 'succeeded', { profileId: request.profileId });
    return { confirmed: true };
  }, reply));
  socket.on('okd:configs:get', (request, reply) => handle(() => {
    exactRequest(request, ['id', 'expectedRevision'], 'Template request is invalid.');
    return okd.getTemplates(request.id, request.expectedRevision);
  }, reply));
  socket.on('okd:configs:save', (request, reply) => handle(() => {
    exactRequest(request, ['id', 'expectedRevision', 'installConfig', 'agentConfig'], 'Template save request is invalid.');
    return mutate('profile.save', { profileId: request.id }, () => okd.saveTemplates(request.id, request.expectedRevision, request.installConfig, request.agentConfig));
  }, reply));
  socket.on('okd:delete', (request, reply) => handle(() => {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !['id', 'confirmed'].includes(key))) throw Object.assign(new Error('Delete request must be an object.'), { code: 'BAD_REQUEST' });
    if (request.confirmed !== true) throw Object.assign(new Error('Confirm profile deletion.'), { code: 'CONFIRMATION_REQUIRED' });
    return mutate('profile.delete', { profileId: request.id }, () => coordinator.delete(request.id));
  }, reply));
  socket.on('okd:tools:status', (release, reply) => handle(async () => ({
    supportedReleases: toolService.supportedReleases,
    ...(await toolService.getToolStatus(release)),
  }), reply));
  socket.on('okd:tools:install', (release, reply) => handle(async () => {
    await audit('tool.install.request', 'requested', {});
    return mutate('tool.install.result', {}, () => toolService.installTools(release));
  }, reply));
  socket.on('okd:pull-secret:status', (request, reply) => handle(() => {
    exactRequest(request, [], 'Pull-secret status request is invalid.');
    return pullSecrets.status();
  }, reply));
  socket.on('okd:pull-secret:save', (request, reply) => handle(() => {
    exactRequest(request, ['secret'], 'Pull-secret save request is invalid.');
    if (typeof request.secret !== 'string' || !request.secret.length || Buffer.byteLength(request.secret) > 1024 * 1024) throw Object.assign(new Error('Pull secret must be nonempty JSON no larger than 1 MiB.'), { code: 'BAD_REQUEST' });
    return mutate('pull-secret.save', { source: 'internal' }, () => pullSecrets.save(request.secret));
  }, reply));
  socket.on('okd:jobs:preflight', (request, reply) => handle(() => {
    exactRequest(request, ['profileId', 'revision'], 'Preflight request is invalid.');
    return jobs.preflight(request.profileId, request.revision);
  }, reply));
  socket.on('okd:jobs:status', (profileId, reply) => handle(() => jobs.getJobStatus(profileId), reply));
  socket.on('okd:jobs:start', (request, reply) => handle(() => {
    exactRequest(request, ['profileId', 'revision', 'confirmed'], 'Generation request is invalid.');
    return coordinator.start(request).then(async (record) => {
      await audit('generation.start', 'succeeded', { profileId: record.profileId, release: record.release, mediaVersion: record.mediaVersion, mode: record.mode });
      return record;
    }).catch(async (err) => { await audit('generation.start', 'failed', { profileId: request.profileId }); throw err; });
  }, reply));
  socket.on('okd:jobs:cancel', (request, reply) => handle(() => {
    exactRequest(request, ['profileId', 'release', 'mediaVersion'], 'Cancellation request is invalid.');
    return mutate('generation.cancel', request, () => jobs.cancelJob(request));
  }, reply));
  socket.on('okd:jobs:log', (request, reply) => handle(() => {
    exactRequest(request, ['profileId', 'release', 'mediaVersion', 'maxBytes'], 'Log request is invalid.');
    return jobs.readJobLog(request, request.maxBytes);
  }, reply));
  socket.on('okd:versions:list', (profileId, reply) => handle(() => artifacts.listVersions(profileId), reply));
  socket.on('okd:versions:publish', (request, reply) => handle(async () => {
    const refs = { profileId: request && request.profileId, release: request && request.release, versionId: request && request.versionId };
    const versions = await artifacts.listVersions(refs.profileId);
    const action = versions.some((version) => version.active) ? 'version.activate' : 'version.publish';
    return mutate(action, refs, () => artifacts.publishVersion(refs.profileId, refs.release, refs.versionId));
  }, reply));
  socket.on('okd:versions:unpublish', (profileId, reply) => handle(() => mutate('version.unpublish', { profileId }, () => artifacts.unpublishProfile(profileId)), reply));
  socket.on('okd:versions:delete', (request, reply) => handle(() => mutate('version.delete', { profileId: request && request.profileId, release: request && request.release, versionId: request && request.versionId }, () => artifacts.deleteVersion(request && request.profileId, request && request.release, request && request.versionId, request && request.confirmed)), reply));
}

jobs.setAuditSink(operations.audit);
registerOkdHandlers.initialize = () => Promise.all([jobs.initialize(), artifacts.reconcilePublications(), operations.initialize()]);
registerOkdHandlers.createProfileJobCoordinator = createProfileJobCoordinator;
module.exports = registerOkdHandlers;
