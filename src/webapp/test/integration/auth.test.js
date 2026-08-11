// Integration tests: HTTP + socket.io authentication and the public routes.
// Real server, real middleware, real socket handshakes — against fixture config.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const USER = 'admin';
const PASS = 'secret';
const basicHeader = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

let ctx;

beforeAll(async () => {
  ctx = await bootApp({ user: USER, pass: PASS });
});

afterAll(async () => {
  if (ctx) await ctx.close();
});

describe('HTTP authentication', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(401);
  });

  it('rejects wrong credentials with 401', async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') },
    });
    expect(res.status).toBe(401);
  });

  it('serves the index page with valid credentials', async () => {
    const res = await fetch(`${ctx.baseUrl}/`, { headers: { Authorization: basicHeader } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UpOnLAN');
  });
});

describe('HTTP routes', () => {
  it('renders the client JS bundle with the javascript content type', async () => {
    const res = await fetch(`${ctx.baseUrl}/uponlanxyz-web.js`, { headers: { Authorization: basicHeader } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('serves vendor static files behind auth', async () => {
    const res = await fetch(`${ctx.baseUrl}/public/vendor/js/jquery.min.js`, { headers: { Authorization: basicHeader } });
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${ctx.baseUrl}/no-such-page`, { headers: { Authorization: basicHeader } });
    expect(res.status).toBe(404);
  });
});

describe('socket.io authentication', () => {
  it('rejects connections without credentials', async () => {
    const socket = ctx.connectClient();
    const outcome = await new Promise((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (e) => resolve(`rejected:${e.message}`));
      setTimeout(() => resolve('timeout'), 4000);
    });
    socket.close();
    expect(outcome).toMatch(/^rejected:/);
  });

  it('accepts connections with an auth token', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    const outcome = await new Promise((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (e) => resolve(`rejected:${e.message}`));
      setTimeout(() => resolve('timeout'), 4000);
    });
    socket.close();
    expect(outcome).toBe('connected');
  });

  it('accepts connections with a Basic authorization header (browser WS upgrade path)', async () => {
    const socket = ctx.connectClient({ extraHeaders: { Authorization: basicHeader } });
    const outcome = await new Promise((resolve) => {
      socket.on('connect', () => resolve('connected'));
      socket.on('connect_error', (e) => resolve(`rejected:${e.message}`));
      setTimeout(() => resolve('timeout'), 4000);
    });
    socket.close();
    expect(outcome).toBe('connected');
  });
});

describe('socket event round-trips', () => {
  it('serves local asset/config state over the socket', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');
    const [args] = await Promise.all([once(socket, 'renderlocal'), Promise.resolve(socket.emit('getlocal'))]);
    const [endpoints, assets, menuversion] = args;
    expect(endpoints.menu.version).toBe('0.0.2'); // from fixture endpoints.yml
    expect(assets.sort()).toEqual(['/ipxe/test-rom.ipxe', '/sample.txt']); // fixture assets dir
    expect(menuversion).toBe('0.0.2');
    socket.close();
  });
});
