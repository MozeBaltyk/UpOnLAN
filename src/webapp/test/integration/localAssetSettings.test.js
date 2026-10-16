import fs from 'fs';
import path from 'path';
import { expect, it, vi } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

it('saves only the shared origin through the real authenticated API, preserves it on invalid requests and refreshes local metadata', async () => {
  vi.stubEnv('OKD_PUBLIC_BASE_URL', '');
  const app = await bootApp();
  const socket = app.connectClient({ auth: { token: 'secret' } });
  const save = (request) => new Promise((resolve, reject) => socket.timeout(5000).emit('localAssets:save', request, (err, response) => err ? reject(err) : resolve(response)));
  const get = () => new Promise((resolve, reject) => socket.timeout(5000).emit('localAssets:get', (err, response) => err ? reject(err) : resolve(response)));
  try {
    await once(socket, 'connect');
    const file = path.join(app.root, 'config/local-assets.json');
    expect(await get()).toEqual({ ok: true, data: { assetUrl: null, overrideActive: false } });
    expect((await save({ assetUrl: 'https://192.168.7.1:8443/' })).ok).toBe(true);
    const stored = fs.readFileSync(file, 'utf8');
    expect(await get()).toMatchObject({ ok: true, data: { assetUrl: 'https://192.168.7.1:8443/', overrideActive: false } });
    vi.stubEnv('OKD_PUBLIC_BASE_URL', 'https://user:private@invalid.example/');
    expect((await get()).data.overrideActive).toBe(true);
    expect(JSON.stringify(await get())).not.toContain('private');
    vi.stubEnv('OKD_PUBLIC_BASE_URL', '');
    for (const request of [{ assetUrl: 'https://new.example/', path: '/tmp/unwanted' }, { assetUrl: ['https://new.example/'] }, { assetUrl: 'https://user:private@bad.example/' }, { browserHost: 'browser.example' }, { assetUrl: '' }]) {
      const result = await save(request);
      expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('private');
      expect(fs.readFileSync(file, 'utf8')).toBe(stored);
    }
    const pending = once(socket, 'renderlocal'); socket.emit('getlocal');
    const args = await pending;
    expect(args[5]).toBe('https://192.168.7.1:8443');
    expect(args[7]).toEqual({ assetUrl: 'https://192.168.7.1:8443/', error: '' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await save({ assetUrl: 'https://changed.example:8443/' })).ok).toBe(true);
    expect((await get()).data.assetUrl).toBe('https://changed.example:8443/');
  } finally { socket.close(); await app.close(); vi.unstubAllEnvs(); }
});
