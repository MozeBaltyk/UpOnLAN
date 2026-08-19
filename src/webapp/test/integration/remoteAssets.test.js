// Verifies the Remote Assets tab data flow end-to-end using the real generated
// asset catalog from release/output/assets/endpoints.yml. The webapp serves that
// file via the getlocal socket as the available remote endpoints list.
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const ENDPOINTS = path.join(REPO_ROOT, 'release', 'output', 'assets', 'endpoints.yml');

// release/output is gitignored and only exists after ./wakemeup.sh -a mirror-assets.
// Skip when absent (e.g. fresh CI checkout) instead of failing.
describe.skipIf(!fs.existsSync(ENDPOINTS))('remote assets from generated release output', () => {
  let endpointsYml;

  beforeAll(() => {
    endpointsYml = fs.readFileSync(ENDPOINTS, 'utf8');
  });

  it('serves endpoint entries through the getlocal socket', async () => {
    const app = await bootApp({
      fixtures: { 'config/endpoints.yml': endpointsYml },
    });
    const socket = app.connectClient({ auth: { token: 'secret' } });

    try {
      await once(socket, 'connect');
      const [args] = await Promise.all([once(socket, 'renderlocal'), Promise.resolve(socket.emit('getlocal'))]);

      const [endpoints] = args;
      // The tab iterates endpoints.endpoints; it must be populated, not empty.
      expect(endpoints.endpoints).toBeDefined();
      const keys = Object.keys(endpoints.endpoints);
      expect(keys.length).toBeGreaterThan(0);

      // Every entry must be well-formed so the tab can list and download it.
      // The mirror may legitimately hold only a subset of OSes (e.g. built with
      // asset_target=harvester), so do not require any specific endpoint key.
      for (const key of keys) {
        const ep = endpoints.endpoints[key];
        expect(ep.path, `endpoint ${key}`).toContain('/assets/');
        expect(Array.isArray(ep.files), `endpoint ${key}`).toBe(true);
        expect(ep.files.length, `endpoint ${key}`).toBeGreaterThan(0);
      }
    } finally {
      // Close the socket before the server so a failed assertion cannot hang
      // app.close() on the still-open connection.
      socket.close();
      await app.close();
    }
  });
});