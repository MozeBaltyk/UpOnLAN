// E2E: critical business journeys driven through the real server, real
// sockets and the real filesystem — the same path a browser session takes.
//
//   Journey 1 — WoL lifecycle: read -> add -> wake -> delete
//   Journey 2 — PXE menu lifecycle: create -> save -> read-back -> revert
//   Journey 3 — attacker without credentials is blocked end-to-end
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const PASS = 'secret';
const USER = 'admin';
const basicHeader = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

let ctx;

beforeAll(async () => {
  ctx = await bootApp({ user: USER, pass: PASS });
});

afterAll(async () => {
  if (ctx) await ctx.close();
});

describe('Journey: Wake-on-LAN lifecycle', () => {
  it('reads, adds, wakes and removes a host', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');

    // 1. read current state
    let [args] = await Promise.all([once(socket, 'renderwol'), Promise.resolve(socket.emit('getwol'))]);
    const before = args[0].wakeonlan.map((e) => e.default_mac);
    expect(before).toContain('00:11:22:33:44:55');

    // 2. add a host
    [args] = await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('addwol', { default_mac: 'AA:BB:CC:DD:EE:FF', name: 'Study PC' })),
    ]);
    expect(args[0].wakeonlan).toHaveLength(before.length + 1);

    // 3. wake it — valid MAC must pass validation
    const wakeResult = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 4000);
      socket.on('info', (m) => { clearTimeout(t); resolve(`info:${m}`); });
      socket.on('error', (m) => { clearTimeout(t); resolve(`error:${m}`); });
      socket.emit('wakewol', 'AA:BB:CC:DD:EE:FF');
    });
    expect(wakeResult).not.toContain('Invalid MAC address');

    // 4. remove it again
    [args] = await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('deletewol', 'AA:BB:CC:DD:EE:FF')),
    ]);
    expect(args[0].wakeonlan.map((e) => e.default_mac)).toEqual(before);

    socket.close();
  });
});

describe('Journey: PXE menu lifecycle', () => {
  it('creates, edits and reverts a local menu override', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');

    // 1. create a new local menu file
    await Promise.all([once(socket, 'renderconfig'), Promise.resolve(socket.emit('createipxe', 'lab.ipxe'))]);
    let localPath = path.join(process.env.UPONLAN_CONFIG, 'menus', 'local', 'lab.ipxe');
    expect(fs.readFileSync(localPath, 'utf8')).toBe('#!ipxe');

    // 2. edit it
    await Promise.all([
      once(socket, 'renderconfig'),
      Promise.resolve(socket.emit('saveconfig', 'lab.ipxe', '#!ipxe\necho LAB MENU\nchain other.ipxe\n')),
    ]);

    // 3. read it back through the editor endpoint
    const [args] = await Promise.all([
      once(socket, 'editrenderfile'),
      Promise.resolve(socket.emit('editgetfile', 'lab.ipxe', true)),
    ]);
    expect(args[0]).toContain('echo LAB MENU');

    // 4. revert it (delete the local override)
    await Promise.all([once(socket, 'renderconfig'), Promise.resolve(socket.emit('revertconfig', 'lab.ipxe'))]);
    expect(fs.existsSync(localPath)).toBe(false);

    socket.close();
  });

  it('disables iPXE signatures after a menu write', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');

    // fixture remote/boot.cfg has sigs_enabled true; a write triggers disablesigs()
    await Promise.all([once(socket, 'renderconfig'), Promise.resolve(socket.emit('createipxe', 'sigs.ipxe'))]);
    const bootCfg = fs.readFileSync(path.join(process.env.UPONLAN_CONFIG, 'menus', 'remote', 'boot.cfg'), 'utf8');
    expect(bootCfg).toContain('set sigs_enabled false');
    expect(bootCfg).not.toContain('set sigs_enabled true');

    socket.close();
  });
});

describe('Journey: unauthenticated attacker is blocked', () => {
  it('cannot connect to the socket at all', async () => {
    const socket = ctx.connectClient();
    const outcome = await new Promise((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (e) => resolve(`blocked:${e.message}`));
      setTimeout(() => resolve('timeout'), 4000);
    });
    socket.close();
    expect(outcome).toMatch(/^blocked:/);
  });

  it('cannot reach the web UI without credentials', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(401);
  });

  it('is rejected even with a forged token but no valid session', async () => {
    const socket = ctx.connectClient({ auth: { token: 'guessed-token' } });
    const outcome = await new Promise((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (e) => resolve(`blocked:${e.message}`));
      setTimeout(() => resolve('timeout'), 4000);
    });
    socket.close();
    expect(outcome).toMatch(/^blocked:/);
  });

  it('authenticated session works end-to-end (HTTP + socket)', async () => {
    const page = await fetch(`${ctx.baseUrl}/`, { headers: { Authorization: basicHeader } });
    expect(page.status).toBe(200);

    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');
    const [args] = await Promise.all([once(socket, 'renderwol'), Promise.resolve(socket.emit('getwol'))]);
    expect(args[0].wakeonlan).toBeInstanceOf(Array);
    socket.close();
  });
});
