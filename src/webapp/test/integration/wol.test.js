// Integration tests: WoL CRUD + wake validation over the real socket with a
// real fixture wol.yml (persistence to disk verified end-to-end).
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

function persistedWol() {
  return fs.readFileSync(path.join(process.env.UPONLAN_CONFIG, 'wol.yml'), 'utf8');
}

describe('wol socket handlers', () => {
  it('returns persisted entries from wol.yml', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([once(socket, 'renderwol'), Promise.resolve(socket.emit('getwol'))]);
    expect(args[0].wakeonlan.map((e) => e.default_mac)).toEqual(['00:11:22:33:44:55']);
    socket.close();
  });

  it('adds a valid entry and persists it to disk', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('addwol', { default_mac: 'AA:BB:CC:DD:EE:FF', name: 'New host' })),
    ]);
    expect(args[0].wakeonlan).toHaveLength(2);
    expect(persistedWol()).toContain('AA:BB:CC:DD:EE:FF');

    // restore fixture state
    await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('deletewol', 'AA:BB:CC:DD:EE:FF')),
    ]);
    socket.close();
  });

  it('rejects an invalid MAC with an error event', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([
      once(socket, 'error'),
      Promise.resolve(socket.emit('addwol', { default_mac: '00:11:22:33:44:55; rm -rf /' })),
    ]);
    expect(args[0]).toBe('Invalid MAC address');
    socket.close();
  });

  it('rejects a duplicate MAC with an error event', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([
      once(socket, 'error'),
      Promise.resolve(socket.emit('addwol', { default_mac: '00:11:22:33:44:55' })),
    ]);
    expect(args[0]).toBe('MAC address already exists');
    socket.close();
  });

  it('deletes an entry and persists the change', async () => {
    const socket = await authedSocket();
    // seed a second entry, then delete the fixture one
    await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('addwol', { default_mac: 'AA:BB:CC:DD:EE:FF', name: 'temp' })),
    ]);

    const [args] = await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('deletewol', '00:11:22:33:44:55')),
    ]);
    expect(args[0].wakeonlan.map((e) => e.default_mac)).toEqual(['AA:BB:CC:DD:EE:FF']);
    socket.close();
  });
});

describe('wol wake validation over the socket', () => {
  it('reports a validation error for a shell-payload MAC', async () => {
    const socket = await authedSocket();
    const [args] = await Promise.all([
      once(socket, 'error'),
      Promise.resolve(socket.emit('wakewol', '00:11:22:33:44:55; reboot')),
    ]);
    expect(args[0]).toContain('Invalid MAC address');
    socket.close();
  });

  it('passes a valid MAC through validation (no validation error)', async () => {
    const socket = await authedSocket();
    // Valid MAC passes the validation gate and attempts `awake`. The `awake`
    // binary is absent on a dev host, so an exec error is fine — what matters
    // is that the validation gate never fires for a well-formed MAC.
    const result = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 4000);
      socket.on('info', (msg) => { clearTimeout(t); resolve(`info:${msg}`); });
      socket.on('error', (msg) => { clearTimeout(t); resolve(`error:${msg}`); });
      socket.emit('wakewol', '00:11:22:33:44:55');
    });
    expect(result).not.toContain('Invalid MAC address');
    socket.close();
  });
});
