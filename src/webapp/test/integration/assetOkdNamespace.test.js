import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';
const require = createRequire(import.meta.url);
const { COMPATIBILITY_RECORD } = require('../../services/okdServices.js');

function okdFixtures() {
  const profileId = 'lab-okd'; const versionId = '11111111-1111-1111-1111-111111111111';
  const values = { kernel: 'kernel', initrd: 'initrd', rootfs: 'rootfs', ipxe: '#!ipxe\nboot\n' };
  const names = { ...COMPATIBILITY_RECORD.outputs.pxe, ipxe: 'boot.ipxe' };
  const files = Object.keys(values).map((role) => ({ role, name: names[role], size: Buffer.byteLength(values[role]), sha256: crypto.createHash('sha256').update(values[role]).digest('hex') }));
  const manifest = {
    schemaVersion: 1, profileId, profileRevision: 'a'.repeat(64), jobId: versionId, versionId, mode: 'pxe',
    release: COMPATIBILITY_RECORD.release, releaseImage: COMPATIBILITY_RECORD.releaseImage,
    releaseDigest: COMPATIBILITY_RECORD.releaseDigest, compatibilityRevision: COMPATIBILITY_RECORD.revision,
    installer: { archiveSha256: 'b'.repeat(64), binarySha256: 'c'.repeat(64) }, files,
    createdAt: '2026-10-16T00:00:00.000Z', publicBaseUrl: 'https://192.168.7.1:8443/',
  };
  const prefix = `assets/okd/${profileId}/${versionId}/`;
  return {
    'config/local-assets.json': '{"assetUrl":"https://192.168.7.1:8443/"}\n',
    [`config/okd/publications/${profileId}.json`]: `${JSON.stringify({ profileId, versionId, activatedAt: '2026-10-16T00:01:00.000Z' })}\n`,
    [`${prefix}manifest.json`]: `${JSON.stringify(manifest)}\n`,
    ...Object.fromEntries(Object.keys(values).map((role) => [`${prefix}${names[role]}`, values[role]])),
  };
}

describe('generic asset handlers reserve the OKD namespace', () => {
  it('lists only manifest-verified OKD files through the read-only artifact API', async () => {
    const app = await bootApp({ fixtures: okdFixtures() });
    const socket = app.connectClient({ auth: { token: 'secret' } });
    try {
      await once(socket, 'connect');
      const pending = once(socket, 'renderlocal'); socket.emit('getlocal'); const args = await pending;
      expect(args[1].some((file) => file.toLowerCase().startsWith('/okd/'))).toBe(false);
      expect(args[8]).toEqual([expect.objectContaining({
        profileId: 'lab-okd', mode: 'pxe', active: true,
        files: expect.arrayContaining([
          expect.objectContaining({ name: 'boot.ipxe', url: expect.stringMatching(/\/okd\/lab-okd\/[^/]+\/boot\.ipxe$/) }),
          expect.objectContaining({ name: 'agent.x86_64-vmlinuz' }),
          expect.objectContaining({ name: 'agent.x86_64-initrd.img' }),
          expect.objectContaining({ name: 'agent.x86_64-rootfs.img' }),
        ]),
      })]);
      expect(JSON.stringify(args[8])).not.toMatch(/manifest\.json|install-config|agent-config|pull.?secret|private.?key|workspace/i);
    } finally { socket.close(); await app.close(); }
  });

  it('hides OKD files and blocks delete/download path variants', async () => {
    const app = await bootApp({ fixtures: {
      'assets/okd/lab/version/manifest.json': '{"private":"okd"}',
      'assets/OKD/case-variant.txt': 'reserved',
    } });
    const socket = app.connectClient({ auth: { token: 'secret' } });
    const protectedFile = path.join(app.root, 'assets', 'okd', 'lab', 'version', 'manifest.json');
    try {
      await once(socket, 'connect');
      const [local] = await Promise.all([once(socket, 'renderlocal'), Promise.resolve(socket.emit('getlocal'))]);
      expect(local[1].some((file) => file.toLowerCase().startsWith('/okd/'))).toBe(false);

      const variants = [
        '/okd/lab/version/manifest.json', '/OKD/lab/version/manifest.json',
        '/assets/okd/lab/version/manifest.json', '/foo/../okd/lab/version/manifest.json',
        '/%6fkd/lab/version/manifest.json', '/%256fkd/lab/version/manifest.json',
        '\\okd\\lab\\version\\manifest.json',
      ];
      const deleted = once(socket, 'renderlocalhook');
      socket.emit('deletelocal', variants);
      await deleted;
      expect(fs.existsSync(protectedFile)).toBe(true);

      const blocked = once(socket, 'error');
      socket.emit('dlremote', ['/assets/%4fKD/lab/version/manifest.json']);
      expect((await blocked)[0]).toContain('reserved or unsafe');
      expect(fs.existsSync(protectedFile)).toBe(true);
    } finally {
      socket.close();
      await app.close();
    }
  });
});
