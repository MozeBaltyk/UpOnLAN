import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createPullSecretService } = require('../../services/okdPullSecretServices.js');
const first = '{"auths":{"quay.io":{"auth":"first-private-value"}}}';
const second = '{"auths":{"quay.io":{"identitytoken":"second-private-value"}}}';
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'okd-pull-secret-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function service(overrides = {}) {
  return createPullSecretService({ configRoot: path.join(root, 'config'), externalFile: path.join(root, 'default-external'), authConfigured: () => true, persistenceReady: true, ...overrides });
}

describe('OKD pull-secret storage', () => {
  it('resolves the public default without writing or exposing credentials, then prefers internal and external secrets', async () => {
    const svc = service();
    expect(await svc.resolve()).toEqual({ raw: '{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}', parsed: { auths: { fake: { auth: 'aWQ6cGFzcwo=' } } }, source: 'default' });
    expect(await svc.status()).toEqual({ status: 'ready', source: 'default', exists: false, writable: true, authenticationConfigured: true, disabledReasons: [] });
    expect(fs.readdirSync(root)).toEqual([]);
    await svc.save(first);
    expect(await svc.resolve()).toMatchObject({ raw: first, source: 'internal' });
    fs.writeFileSync(path.join(root, 'default-external'), second);
    expect(await svc.resolve()).toMatchObject({ raw: second, source: 'external' });
    expect(await svc.status()).toMatchObject({ status: 'ready', source: 'external', writable: false });
    expect(fs.readFileSync(path.join(root, 'config/okd/secrets/pull-secret'), 'utf8')).toBe(first);
  });

  it.each(['internal', 'external'])('never substitutes the default for invalid or unsafe existing %s storage', async (source) => {
    const file = source === 'internal' ? path.join(root, 'config/okd/secrets/pull-secret') : path.join(root, 'default-external');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'invalid-private-value');
    await expect(service().resolve()).rejects.toMatchObject({ code: 'PULL_SECRET_INVALID' });
    expect(await service().status()).toMatchObject({ status: 'invalid', source, exists: true });
    fs.unlinkSync(file); fs.mkdirSync(file);
    await expect(service().resolve()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it.each(['internal', 'external'])('does not fall back when existing %s storage is unreadable', async (source) => {
    const file = source === 'internal' ? path.join(root, 'config/okd/secrets/pull-secret') : path.join(root, 'default-external');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, first);
    vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(service().resolve()).rejects.toMatchObject({ code: source === 'external' ? 'PULL_SECRET_UNAVAILABLE' : 'EACCES' });
    expect(await service().status()).toMatchObject({ status: 'invalid', source, exists: true });
  });
  it('saves and atomically updates a valid internal secret without exposing it in status', async () => {
    let oldAtRename;
    const internal = path.join(root, 'config/okd/secrets/pull-secret');
    const svc = service({ renameFile: async (from, to) => { oldAtRename = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null; await fs.promises.rename(from, to); } });
    await svc.save(first);
    expect(fs.statSync(path.dirname(internal)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(internal).mode & 0o777).toBe(0o600);
    const status = await svc.status();
    expect(status).toEqual({ status: 'ready', source: 'internal', exists: true, writable: true, authenticationConfigured: true, disabledReasons: [] });
    expect(JSON.stringify(status)).not.toMatch(/first-private-value|quay\.io|"auths"|"raw"|"parsed"/);
    await svc.save(second);
    expect(oldAtRename).toBe(first);
    expect(fs.readFileSync(internal, 'utf8')).toBe(second);
  });

  it('rejects invalid and oversized input while retaining the valid secret', async () => {
    const svc = service(); const internal = path.join(root, 'config/okd/secrets/pull-secret');
    await svc.save(first);
    await expect(svc.save('{"auths":{}}')).rejects.toMatchObject({ code: 'PULL_SECRET_INVALID' });
    await expect(svc.save('x'.repeat(1024 * 1024 + 1))).rejects.toMatchObject({ code: 'PULL_SECRET_INVALID' });
    expect(fs.readFileSync(internal, 'utf8')).toBe(first);
  });

  it('rejects a symlinked internal path', async () => {
    const dir = path.join(root, 'config/okd/secrets'); fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, first); fs.symlinkSync(outside, path.join(dir, 'pull-secret'));
    await expect(service().save(second)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fs.readFileSync(outside, 'utf8')).toBe(first);
  });

  it('allows internal management without web authentication when persistence is ready', async () => {
    const svc = service({ authConfigured: () => false });
    expect(await svc.status()).toMatchObject({ status: 'ready', source: 'default', exists: false, writable: true, authenticationConfigured: false, disabledReasons: [] });
    expect(await svc.save(first)).toMatchObject({ status: 'ready', source: 'internal', writable: true, authenticationConfigured: false });
    expect(await svc.resolve()).toMatchObject({ raw: first, source: 'internal' });
  });

  it('explains that shell-style outer quotes are not JSON without echoing input', async () => {
    const input = `'${first}'`;
    const error = await service().save(input).catch((err) => err);
    expect(error).toMatchObject({ code: 'PULL_SECRET_INVALID', message: expect.stringContaining('without surrounding shell-style quotes') });
    expect(error.message).not.toContain('first-private-value');
  });

  it('explains that JSON encoded as a quoted string is not a pull-secret object', async () => {
    const error = await service().save(JSON.stringify(first)).catch((err) => err);
    expect(error).toMatchObject({ code: 'PULL_SECRET_INVALID', message: expect.stringContaining('not quoted JSON') });
    expect(error.message).not.toContain('first-private-value');
  });

  it('requires persistent config storage for mutation', async () => {
    const svc = service({ persistenceReady: false });
    await expect(svc.save(first)).rejects.toMatchObject({ code: 'PERSISTENCE_REQUIRED' });
    expect(await svc.status()).toMatchObject({ status: 'ready', source: 'default', writable: false });
  });

  it('gives explicit or present external storage precedence and never falls back', async () => {
    const external = path.join(root, 'external');
    await service().save(first);
    await expect(service({ externalFile: external, externalConfigured: true }).resolve()).rejects.toMatchObject({ code: 'PULL_SECRET_UNAVAILABLE' });
    expect(await service({ externalFile: external, externalConfigured: true }).status()).toMatchObject({ status: 'invalid', source: 'external', exists: false, writable: false });
    await expect(service({ externalFile: external, externalConfigured: true }).save(first)).rejects.toMatchObject({ code: 'EXTERNALLY_MANAGED' });
    fs.writeFileSync(external, second);
    const svc = service({ externalFile: external });
    expect(await svc.resolve()).toMatchObject({ raw: second, source: 'external' });
    await expect(svc.save(first)).rejects.toMatchObject({ code: 'EXTERNALLY_MANAGED' });
  });
});
