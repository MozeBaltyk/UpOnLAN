// Regression: dlremote must surface failures to the client instead of failing
// silently. The downloader rejects on 404/refused connections; assetHandlers
// now catches that and emits an 'error' event (was: unhandled rejection, zero
// client feedback).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

describe('dlremote failure surfaces to client', () => {
  it('emits an error event when the asset download fails', async () => {
    // origin points at a port nothing listens on -> connection refused
    const endpointsYml = [
      'endpoints:',
      '  oracle-8-x86_64:',
      '    path: /releases/download/oracle-8-x86_64/',
      '    files:',
      '    - vmlinuz',
    ].join('\n');
    const menuYml = [
      'menu:',
      '  origin: http://127.0.0.1:1',
      '  version: local-test',
    ].join('\n');

    const app = await bootApp({
      fixtures: { 'config/endpoints.yml': endpointsYml, 'config/menu.yml': menuYml },
    });

    try {
      const socket = app.connectClient({ auth: { token: 'secret' } });
      await once(socket, 'connect');

      // dlremote must answer with an error event (not hang, not die silently).
      // The downloader retries (2x 5s), so allow ~15s for the error to surface.
      const errorPromise = once(socket, 'error', 15000);
      socket.emit('dlremote', ['/releases/download/oracle-8-x86_64/vmlinuz']);
      const [msg] = await errorPromise;
      expect(String(msg)).toMatch(/download failed/i);

      socket.close();
    } finally {
      await app.close();
    }
  });
});

describe('dlremote strips the local assets/ namespace', () => {
  it('stores /assets/<key>/vmlinuz under /assets/<key>/vmlinuz (no doubling)', async () => {
    // Mock local mirror: serves the asset at /assets/<key>/vmlinuz (the URL path
    // in endpoints.yml). The filesystem must not become /assets/assets/<key>/.
    const mirror = http.createServer((req, res) => {
      if (req.url === '/assets/talos-v1.13.8-x86_64/vmlinuz') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('asset-bytes');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => mirror.listen(0, r));
    const { port } = mirror.address();

    const app = await bootApp({
      fixtures: {
        'config/endpoints.yml': [
          'endpoints:',
          '  talos-v1.13.8-x86_64:',
          '    path: /assets/talos-v1.13.8-x86_64/',
          '    files:',
          '    - vmlinuz',
        ].join('\n'),
        'config/menu.yml': `menu:\n  origin: http://127.0.0.1:${port}\n  version: local-test\n`,
      },
    });

    try {
      const socket = app.connectClient({ auth: { token: 'secret' } });
      await once(socket, 'connect');

      const done = once(socket, 'dlremotedone');
      socket.emit('dlremote', ['/assets/talos-v1.13.8-x86_64/vmlinuz']);
      await done;

      const expected = path.join(app.root, 'assets', 'talos-v1.13.8-x86_64', 'vmlinuz');
      const doubled = path.join(app.root, 'assets', 'assets', 'talos-v1.13.8-x86_64', 'vmlinuz');
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.existsSync(doubled)).toBe(false);
      expect(fs.readFileSync(expected, 'utf8')).toBe('asset-bytes');

      socket.close();
    } finally {
      await app.close();
      await new Promise((r) => mirror.close(r));
    }
  });
});
