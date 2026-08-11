// Integration tests: PXE menu management over the real socket + real
// fixture menu files on disk — listing, create, save, revert.
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const PASS = 'secret';

let ctx;

beforeAll(async () => {
  ctx = await bootApp({ pass: PASS });
});

afterAll(async () => {
  if (ctx) await ctx.close();
});

async function authedSocket() {
  const socket = ctx.connectClient({ auth: { token: PASS } });
  await once(socket, 'connect');
  return socket;
}

// renderconfig payload: (remote_files, local_files, rom_files, index_files, nginx_url, menu_version)
const [remoteFiles, localFiles, romFiles, indexFiles] = [0, 1, 2, 3];

describe('menu socket handlers', () => {
  it('lists remote and local iPXE files from disk', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([once(socket, 'renderconfig'), Promise.resolve(socket.emit('getconfig'))]);
    expect(args[remoteFiles]).toContain('example.ipxe');
    expect(args[remoteFiles]).toContain('boot.cfg');
    expect(args[localFiles]).toEqual([]); // no local overrides in fixture
    expect(args[3 + 2]).toBe('0.0.2'); // menu version
    socket.close();
  });

  it('creates a new local iPXE file and publishes it', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderconfig'),
      Promise.resolve(socket.emit('createipxe', 'custom.ipxe')),
    ]);
    const localPath = path.join(process.env.UPONLAN_CONFIG, 'menus', 'local', 'custom.ipxe');
    expect(fs.readFileSync(localPath, 'utf8')).toBe('#!ipxe');
    socket.close();
  });

  it('rejects creating a file with an invalid name', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([
      once(socket, 'error'),
      Promise.resolve(socket.emit('createipxe', '../../evil.ipxe')),
    ]);
    expect(args[0]).toBe('Invalid file path or filename');
    socket.close();
  });

  it('saves content to a local file', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderconfig'),
      Promise.resolve(socket.emit('createipxe', 'editable.ipxe')),
    ]);
    await Promise.all([
      once(socket, 'renderconfig'),
      Promise.resolve(socket.emit('saveconfig', 'editable.ipxe', '#!ipxe\necho edited\n')),
    ]);
    const localPath = path.join(process.env.UPONLAN_CONFIG, 'menus', 'local', 'editable.ipxe');
    expect(fs.readFileSync(localPath, 'utf8')).toBe('#!ipxe\necho edited\n');
    socket.close();
  });

  it('reverts a local override by deleting it', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderconfig'),
      Promise.resolve(socket.emit('createipxe', 'temp-revert.ipxe')),
    ]);
    const localPath = path.join(process.env.UPONLAN_CONFIG, 'menus', 'local', 'temp-revert.ipxe');
    expect(fs.existsSync(localPath)).toBe(true);

    await Promise.all([
      once(socket, 'renderconfig'),
      Promise.resolve(socket.emit('revertconfig', 'temp-revert.ipxe')),
    ]);
    expect(fs.existsSync(localPath)).toBe(false);
    socket.close();
  });

  it('reads a file for editing (editgetfile)', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([
      once(socket, 'editrenderfile'),
      Promise.resolve(socket.emit('editgetfile', 'example.ipxe', false)),
    ]);
    const [content, filename, islocal] = args;
    expect(filename).toBe('example.ipxe');
    expect(content).toContain('#!ipxe');
    expect(islocal).toBe(false);
    socket.close();
  });

  it('blocks directory traversal when reading a file', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([
      once(socket, 'error'),
      Promise.resolve(socket.emit('editgetfile', '../../etc/passwd', true)),
    ]);
    expect(args[0]).toBe('Invalid file path');
    socket.close();
  });
});
