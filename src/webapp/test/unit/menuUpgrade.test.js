import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureRoot } from '../helpers/fixtures.js';

const require = createRequire(import.meta.url);
function loadService() {
  for (const file of Object.keys(require.cache)) if (file.includes('/src/webapp/')) delete require.cache[file];
  return require('../../services/menuServices.js');
}

describe('menu upgrade staging', () => {
  afterEach(() => { vi.resetModules(); delete process.env.UPONLAN_CONFIG; delete process.env.UPONLAN_ASSETS; });

  it('preserves active content when archive validation fails', async () => {
    const server = http.createServer((_req, res) => res.end('not a tar archive'));
    await new Promise((resolve) => server.listen(0, resolve));
    const root = createFixtureRoot({
      'config/menu.yml': `menu:\n  origin: http://127.0.0.1:${server.address().port}\n  version: old\n`,
    });
    process.env.UPONLAN_CONFIG = path.join(root, 'config');
    process.env.UPONLAN_ASSETS = path.join(root, 'assets');
    const service = loadService();
    const before = fs.readFileSync(path.join(root, 'config/menus/remote/boot.cfg'), 'utf8');
    try {
      const error = await new Promise((resolve) => service.upgrademenu('bad', (err) => resolve(err), { emit() {} }));
      expect(error).toBeInstanceOf(Error);
      expect(fs.readFileSync(path.join(root, 'config/menus/remote/boot.cfg'), 'utf8')).toBe(before);
      expect(fs.readFileSync(path.join(root, 'config/menu.yml'), 'utf8')).toContain('version: old');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  async function runArchiveUpgrade(files, configure = () => {}) {
    const root = createFixtureRoot({
      'config/menus/remote/old.ipxe': '#!ipxe\necho old\n',
      'config/menus/old.ipxe': '#!ipxe\necho old\n',
      'config/menus/obsolete.ipxe': '#!ipxe\necho obsolete\n',
    });
    const source = path.join(root, 'archive');
    fs.mkdirSync(source);
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), content);
    }
    const archive = path.join(root, 'menus.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const server = http.createServer((_req, res) => res.end(fs.readFileSync(archive)));
    await new Promise((resolve) => server.listen(0, resolve));
    fs.writeFileSync(path.join(root, 'config/menu.yml'), `menu:\n  origin: http://127.0.0.1:${server.address().port}\n  version: old\n`);
    process.env.UPONLAN_CONFIG = path.join(root, 'config');
    process.env.UPONLAN_ASSETS = path.join(root, 'assets');
    configure(root);
    const service = loadService();
    const error = await new Promise((resolve) => service.upgrademenu('new', (err) => resolve(err), { emit() {} }));
    await new Promise((resolve) => server.close(resolve));
    return { root, error };
  }

  it('removes obsolete generated top-level files after a successful upgrade', async () => {
    const { root, error } = await runArchiveUpgrade({
      'boot.cfg': '#!ipxe\nset sigs_enabled true\n',
      'current.ipxe': '#!ipxe\necho current\n',
    });
    try {
      expect(error).toBeNull();
      expect(fs.existsSync(path.join(root, 'config/menus/obsolete.ipxe'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'config/menus/current.ipxe'), 'utf8')).toContain('current');
      for (const directory of ['local', 'remote', 'rom']) expect(fs.statSync(path.join(root, 'config/menus', directory)).isDirectory()).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('removes partially copied new-only files before rollback layering', async () => {
    const { root, error } = await runArchiveUpgrade({
      'boot.cfg': '#!ipxe\nset sigs_enabled true\n',
      'aaa.ipxe': '#!ipxe\necho new only\n',
      'blocked.ipxe': '#!ipxe\necho fail here\n',
    }, (fixture) => fs.mkdirSync(path.join(fixture, 'config/menus/blocked.ipxe')));
    try {
      expect(error).toBeInstanceOf(Error);
      expect(fs.existsSync(path.join(root, 'config/menus/aaa.ipxe'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'config/menus/old.ipxe'), 'utf8')).toContain('old');
      expect(fs.readFileSync(path.join(root, 'config/menu.yml'), 'utf8')).toContain('version: old');
      expect(fs.statSync(path.join(root, 'config/menus/blocked.ipxe')).isDirectory()).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
