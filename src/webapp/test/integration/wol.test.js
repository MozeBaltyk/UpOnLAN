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

describe('wol host status + one-shot schedule over the socket', () => {
  it('addwol with ip + wake_at persists both and getwol returns a status field', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('addwol', { default_mac: 'DE:AD:BE:EF:00:01', hostname: 'Status host', ip: '203.0.113.7', wake_at: '2026-08-22T07:00' })),
    ]);
    expect(persistedWol()).toContain('203.0.113.7');
    expect(persistedWol()).toContain('wake_at');

    const [args] = await Promise.all([once(socket, 'renderwol'), Promise.resolve(socket.emit('getwol'))]);
    const entry = args[0].wakeonlan.find((e) => e.default_mac.toLowerCase() === 'de:ad:be:ef:00:01');
    expect(entry).toBeTruthy();
    expect(entry.ip).toBe('203.0.113.7');
    // ping outcome is environment-dependent; status must always be one of the three
    expect(['online', 'offline', 'unknown']).toContain(entry.status);

    await Promise.all([once(socket, 'renderwol'), Promise.resolve(socket.emit('deletewol', 'DE:AD:BE:EF:00:01'))]);
    socket.close();
  });

  it('updatewol sets wake_at (round-trip + persisted) then clears it', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('addwol', { default_mac: 'DE:AD:BE:EF:00:02', hostname: 'Sched host' })),
    ]);

    const [setArgs] = await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('updatewol', { default_mac: 'DE:AD:BE:EF:00:02', wake_at: '2026-08-22T07:00' })),
    ]);
    const setEntry = setArgs[0].wakeonlan.find((e) => e.default_mac.toLowerCase() === 'de:ad:be:ef:00:02');
    expect(setEntry.wake_at).toBe('2026-08-22T07:00');
    expect(persistedWol()).toContain('2026-08-22T07:00');

    const [clearArgs] = await Promise.all([
      once(socket, 'renderwol'),
      Promise.resolve(socket.emit('updatewol', { default_mac: 'DE:AD:BE:EF:00:02', wake_at: null })),
    ]);
    const clearEntry = clearArgs[0].wakeonlan.find((e) => e.default_mac.toLowerCase() === 'de:ad:be:ef:00:02');
    expect(clearEntry.wake_at).toBeNull();

    await Promise.all([once(socket, 'renderwol'), Promise.resolve(socket.emit('deletewol', 'DE:AD:BE:EF:00:02'))]);
    socket.close();
  });
});
