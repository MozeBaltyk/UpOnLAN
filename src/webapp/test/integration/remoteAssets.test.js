// Verifies the Remote Assets tab data flow end-to-end, as it happens in the
// container: init.sh extracts endpoints.yml from menus.tar.gz into
// /config/endpoints.yml, then the webapp serves it via the getlocal socket.
// Uses the real endpoints.yml shipped in release/githubout/menus.tar.gz.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { describe, expect, it, beforeAll } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const TARBALL = path.join(REPO_ROOT, 'release', 'githubout', 'menus.tar.gz');

describe('remote assets from shipped menus.tar.gz', () => {
  let endpointsYml;

  beforeAll(() => {
    // Replicate init.sh: extract tarball, read endpoints.yml from inside it
    expect(fs.existsSync(TARBALL)).toBe(true);
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uponlan-tar-'));
    execFileSync('tar', ['-xzf', TARBALL, '-C', extractDir, './endpoints.yml']);
    endpointsYml = fs.readFileSync(path.join(extractDir, 'endpoints.yml'), 'utf8');
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
