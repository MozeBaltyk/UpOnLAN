import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { createSettings, validateOrigin } = require('../../services/localAssetSettings');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-settings-')); vi.stubEnv('OKD_PUBLIC_BASE_URL', ''); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it.each(['https://localhost', 'https://LOCALHOST.', 'https://a.localhost.', 'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:7f00:1]', 'https://0.0.0.0', 'https://169.254.1.1', 'https://224.0.0.1', 'https://[fe80::1]', 'https://[ff02::1]', 'https://[::]', 'https://user:private@example.com', 'https://@example.com', 'http://example.com', 'https://example.com/a/..', 'https://example.com/%2e', 'https://example.com?', 'https://example.com#', 'https://bad_name', 'https://-bad.example', '', null, {}, ['https://example.com']])('rejects unsafe origin without reflecting input: %j', (value) => {
  expect(() => validateOrigin(value)).toThrow();
  try { validateOrigin(value); } catch (err) { expect(err.message).not.toContain('private'); }
});
it.each(['https://192.168.7.1:8443/', 'https://192.168.1.10:8443/', 'https://10.0.0.1/', 'https://[fd12::1]/', 'https://pxeserver:8443/', 'https://PXE.EXAMPLE.COM:443'])('accepts explicitly selected private addresses and valid hostnames: %s', (url) => {
  expect(validateOrigin(url)).toBe(new URL(url).origin + '/');
});
it('persists across instances, resolves override first, and fails closed', () => {
  const settings = createSettings({ configRoot: root });
  expect(() => settings.resolve()).toThrow('No node-reachable');
  settings.save({ assetUrl: 'https://pxe.example.com:8443' });
  expect(fs.statSync(path.join(root, 'local-assets.json')).mode & 0o777).toBe(0o600);
  expect(createSettings({ configRoot: root }).resolve()).toEqual({ url: 'https://pxe.example.com:8443/', source: 'Shared Local Assets' });
  vi.stubEnv('OKD_PUBLIC_BASE_URL', 'https://override.example.com');
  expect(settings.resolve()).toEqual({ url: 'https://override.example.com/', source: 'OKD override' });
  expect(() => settings.resolve({ publicBaseUrl: undefined })).toThrow();
  vi.stubEnv('OKD_PUBLIC_BASE_URL', 'https://localhost');
  expect(() => settings.resolve()).toThrow();
  vi.stubEnv('OKD_PUBLIC_BASE_URL', '');
  for (const request of [{ assetUrl: 'https://localhost' }, { assetUrl: 'https://safe.example', path: '/tmp/evil' }, { assetUrl: 1 }, { assetUrl: 'x'.repeat(5000) }, []]) expect(() => settings.save(request)).toThrow();
  expect(settings.get()).toBe('https://pxe.example.com:8443/');
  fs.writeFileSync(path.join(root, 'local-assets.json'), '{"assetUrl":"https://localhost"}');
  expect(() => settings.resolve()).toThrow();
});
it('rejects symlink files, hardlinks, directories, oversized data and symlink parents', () => {
  const file = path.join(root, 'local-assets.json');
  const target = path.join(root, 'target'); fs.writeFileSync(target, 'untouched');
  const settings = createSettings({ configRoot: root });
  for (const setup of [() => fs.symlinkSync(target, file), () => fs.linkSync(target, file), () => fs.mkdirSync(file), () => fs.writeFileSync(file, 'x'.repeat(4097))]) {
    setup(); expect(() => settings.get()).toThrow(); expect(() => settings.save({ assetUrl: 'https://safe.example' })).toThrow(); fs.rmSync(file, { recursive: true });
  }
  fs.symlinkSync(root, path.join(root, 'alias'));
  const unsafe = createSettings({ configRoot: path.join(root, 'alias', 'child') });
  expect(() => unsafe.get()).toThrow(); expect(() => unsafe.save({ assetUrl: 'https://safe.example' })).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
});
it('preserves the last valid setting and removes staging data when atomic replacement fails', () => {
  const settings = createSettings({ configRoot: root });
  settings.save({ assetUrl: 'https://original.example/' });
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('storage failure'); });
  try { expect(() => settings.save({ assetUrl: 'https://changed.example/' })).toThrow(); }
  finally { rename.mockRestore(); }
  expect(settings.get()).toBe('https://original.example/');
  expect(fs.readdirSync(root)).toEqual(['local-assets.json']);
});
