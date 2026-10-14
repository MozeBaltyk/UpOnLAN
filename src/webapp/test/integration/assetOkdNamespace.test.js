import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

describe('generic asset handlers reserve the OKD namespace', () => {
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
