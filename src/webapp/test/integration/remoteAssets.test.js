// Verifies the Remote Assets tab data flow end-to-end using the real generated
// asset catalog from release/output/endpoints.yml. The webapp serves that file
// via the getlocal socket as the available remote endpoints list.
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const ENDPOINTS = path.join(REPO_ROOT, 'release', 'output', 'endpoints.yml');

describe('remote assets from generated release output', () => {
  let endpointsYml;

  beforeAll(() => {
    expect(fs.existsSync(ENDPOINTS)).toBe(true);
    endpointsYml = fs.readFileSync(ENDPOINTS, 'utf8');
  });

  it('serves endpoint entries through the getlocal socket', async () => {
    const app = await bootApp({
      fixtures: { 'config/endpoints.yml': endpointsYml },
    });

    try {
      const socket = app.connectClient({ auth: { token: 'secret' } });
      await once(socket, 'connect');
      const [args] = await Promise.all([once(socket, 'renderlocal'), Promise.resolve(socket.emit('getlocal'))]);

      const [endpoints] = args;
      // The tab iterates endpoints.endpoints; it must be populated, not empty
      expect(endpoints.endpoints).toBeDefined();
      expect(Object.keys(endpoints.endpoints).length).toBeGreaterThan(0);

      const oracle = endpoints.endpoints['oracle-8-x86_64'];
      expect(oracle.files).toContain('vmlinuz');
      expect(oracle.files).toContain('initrd');
      socket.close();
    } finally {
      await app.close();
    }
  });
});
