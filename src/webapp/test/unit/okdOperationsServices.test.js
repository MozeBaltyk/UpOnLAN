import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createOperationsService } = require('../../services/okdOperationsServices.js');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'okd-audit-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('minimal OKD audit', () => {
  it('exports only initialize and audit and writes allowlisted identity fields', async () => {
    const svc = createOperationsService({ logsRoot: root, now: () => '2026-10-16T00:00:00.000Z' });
    expect(Object.keys(svc).sort()).toEqual(['audit', 'initialize']);
    await svc.audit('generation.result', 'succeeded', { profileId: 'lab-okd', release: '5.0.0-okd-scos.1', mediaVersion: 'v2', mode: 'pxe', secret: 'never-write' });
    await svc.audit('diagnostics', 'succeeded', { profileId: 'lab-okd' });
    const file = path.join(root, 'okd/audit.jsonl'); const text = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toEqual({ timestamp: '2026-10-16T00:00:00.000Z', action: 'generation.result', outcome: 'succeeded', profileId: 'lab-okd', release: '5.0.0-okd-scos.1', mediaVersion: 'v2', mode: 'pxe' });
    expect(text).not.toMatch(/never-write|diagnostics|jobId|path/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('serializes writes and rotates bounded audit data', async () => {
    const svc = createOperationsService({ logsRoot: root, auditMaxBytes: 1 });
    await Promise.all([svc.audit('profile.save', 'succeeded', { profileId: 'one' }), svc.audit('profile.delete', 'succeeded', { profileId: 'two' })]);
    expect(fs.existsSync(path.join(root, 'okd/audit.jsonl.1'))).toBe(true);
  });

  it('rejects symlinked active and rotated audit files', async () => {
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'private');
    fs.mkdirSync(path.join(root, 'okd')); fs.symlinkSync(outside, path.join(root, 'okd/audit.jsonl'));
    await expect(createOperationsService({ logsRoot: root }).audit('profile.save', 'succeeded', { profileId: 'lab' })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    fs.rmSync(path.join(root, 'okd/audit.jsonl')); const svc = createOperationsService({ logsRoot: root, auditMaxBytes: 1 });
    await svc.audit('profile.save', 'succeeded', { profileId: 'lab' }); fs.symlinkSync(outside, path.join(root, 'okd/audit.jsonl.1'));
    await expect(svc.audit('profile.delete', 'succeeded', { profileId: 'lab' })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('private');
  });
});
