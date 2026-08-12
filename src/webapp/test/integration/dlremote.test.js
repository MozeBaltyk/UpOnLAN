// Regression: dlremote must surface failures to the client instead of failing
// silently. The downloader rejects on 404/refused connections; assetHandlers
// now catches that and emits an 'error' event (was: unhandled rejection, zero
// client feedback).
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
      'menu:',
      '  origin: http://127.0.0.1:1',
      '  version: local-test',
    ].join('\n');

    const app = await bootApp({
      fixtures: { 'config/endpoints.yml': endpointsYml },
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
