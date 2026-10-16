'use strict';
const fs = require('fs');
const path = require('path');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELEASE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const VERSION = /^v[1-9][0-9]*$/;
const AUDIT_LIMIT = 256 * 1024;
const ACTIONS = new Set(['profile.save', 'profile.delete', 'tool.install.request', 'tool.install.result', 'generation.start', 'generation.cancel', 'generation.result', 'version.publish', 'version.unpublish', 'version.activate', 'version.delete', 'certificate.confirm', 'bundle.export', 'pull-secret.save']);

function createOperationsService({ logsRoot = process.env.UPONLAN_LOGS || '/logs', now = () => new Date().toISOString(), auditMaxBytes = AUDIT_LIMIT } = {}) {
  const root = path.join(logsRoot, 'okd'); const file = path.join(root, 'audit.jsonl'); let mutation = Promise.resolve();
  async function initialize() {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('OKD audit storage is unsafe.'), { code: 'UNSAFE_PATH' });
  }
  async function open(flags) {
    let handle;
    try {
      handle = await fs.promises.open(file, flags | fs.constants.O_NOFOLLOW, 0o600); const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe'); await handle.chmod(0o600); return { handle, stat };
    } catch (err) { if (handle) await handle.close().catch(() => {}); throw Object.assign(new Error('OKD audit log is unsafe.'), { code: 'UNSAFE_PATH' }); }
  }
  async function audit(action, outcome, refs = {}) {
    if (!ACTIONS.has(action)) return;
    const event = { timestamp: now(), action, outcome: ['requested', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(outcome) ? outcome : 'failed' };
    if (SLUG.test(refs.profileId || '')) event.profileId = refs.profileId;
    if (RELEASE.test(refs.release || '')) event.release = refs.release;
    if (VERSION.test(refs.mediaVersion || refs.versionId || '')) event.mediaVersion = refs.mediaVersion || refs.versionId;
    if (['pxe', 'iso'].includes(refs.mode)) event.mode = refs.mode;
    const write = async () => {
      await initialize(); let opened = await open(fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
      if (opened.stat.size >= auditMaxBytes) {
        await opened.handle.close();
        const rotated = await fs.promises.lstat(`${file}.1`).catch((err) => err.code === 'ENOENT' ? null : Promise.reject(err));
        if (rotated && (rotated.isSymbolicLink() || !rotated.isFile() || rotated.nlink !== 1)) throw Object.assign(new Error('OKD audit log is unsafe.'), { code: 'UNSAFE_PATH' });
        await fs.promises.rm(`${file}.1`, { force: true }); await fs.promises.rename(file, `${file}.1`); opened = await open(fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
      }
      try { await opened.handle.writeFile(`${JSON.stringify(event)}\n`); } finally { await opened.handle.close(); }
    };
    const next = mutation.then(write, write); mutation = next.catch(() => {}); return next;
  }
  return { initialize, audit };
}
const service = createOperationsService();
module.exports = { createOperationsService, initialize: service.initialize, audit: service.audit };
