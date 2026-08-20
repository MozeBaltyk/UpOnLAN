// Smoke tests: boot the app the way production does (`node app.js`, the
// require.main entrypoint) against a fixture volume, then probe the critical
// surface: HTTP auth, socket auth, and the WoL validation gate.
//
// This is the layer that catches wiring regressions (env plumbing, listen
// setup, module side-effects) that the in-process harness can't.
import { spawn } from 'child_process';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureRoot } from '../helpers/fixtures.js';
import { getFreePort } from '../helpers/bootApp.js';

const WEBAPP_DIR = path.join(__dirname, '..', '..');
const USER = 'admin';
const PASS = 'secret';
const basicHeader = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

let child;
let baseUrl;
let logs = '';

function waitForListening(proc, port) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start within 15s. Logs:\n${logs}`)), 15000);
    proc.stdout.on('data', (d) => {
      logs += d.toString();
      if (d.toString().includes('Server is listening')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr.on('data', (d) => { logs += d.toString(); });
  });
}

beforeAll(async () => {
  const root = createFixtureRoot();
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['app.js'], {
    cwd: WEBAPP_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production', // prod mode: intervals on, auth on
      UPONLAN_CONFIG: path.join(root, 'config'),
      UPONLAN_ASSETS: path.join(root, 'assets'),
      UPONLAN_DOCS: path.join(root, 'docs'),
      UPONLAN_LOGS: path.join(root, 'logs'),
      WEBAPP_USER: USER,
      WEBAPP_PASS: PASS,
      WEB_APP_PORT: String(port),
    },
  });
  await waitForListening(child, port);
}, 20000);

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
});

describe('smoke: production entrypoint', () => {
  it('serves the UI with credentials and rejects without', async () => {
    const denied = await fetch(`${baseUrl}/`);
    expect(denied.status).toBe(401);

    const ok = await fetch(`${baseUrl}/`, { headers: { Authorization: basicHeader } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('UpOnLAN');
  });

  it('accepts authenticated socket connections', async () => {
    const { io } = await import('socket.io-client');
    const socket = io(baseUrl, { transports: ['websocket'], auth: { token: PASS } });
    const outcome = await new Promise((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (e) => resolve(`rejected:${e.message}`));
      setTimeout(() => resolve('timeout'), 5000);
    });
    socket.close();
    expect(outcome).toBe('connected');
  });

  it('rejects unauthenticated socket connections', async () => {
    const { io } = await import('socket.io-client');
    const socket = io(baseUrl, { transports: ['websocket'] });
    const outcome = await new Promise((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (e) => resolve(`rejected:${e.message}`));
      setTimeout(() => resolve('timeout'), 5000);
    });
    socket.close();
    expect(outcome).toMatch(/^rejected:/);
  });

  it('blocks a WoL injection payload at the validation gate', async () => {
    const { io } = await import('socket.io-client');
    const socket = io(baseUrl, { transports: ['websocket'], auth: { token: PASS } });
    await new Promise((resolve) => socket.on('connect', resolve));

    const msg = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 5000);
      socket.on('error', (m) => { clearTimeout(t); resolve(m); });
      socket.emit('wakewol', '00:11:22:33:44:55; reboot');
    });
    socket.close();
    expect(String(msg)).toContain('Invalid MAC address');
  });
});
