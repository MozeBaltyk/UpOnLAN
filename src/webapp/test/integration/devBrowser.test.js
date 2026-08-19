// Regression: "Menu From Endpoint URL" (devgetbrowser) against a flat-file
// mirror (deploy --local). The mirror serves /releases as an HTML directory
// listing — not a GitHub JSON API — so the handler must fall back to the
// menu/latest file instead of crashing on JSON.parse.
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const PASS = 'secret';
let mirror;
let ctx;

function startMirror() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/releases') {
        // python3 -m http.server would return an HTML directory listing here.
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Index of /releases</title>');
      } else if (req.url === '/menu/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"tag_name":"0.0.2"}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    srv.listen(0, () => resolve(srv));
  });
}

beforeAll(async () => {
  mirror = await startMirror();
  const { port } = mirror.address();
  ctx = await bootApp({
    fixtures: {
      'config/menu.yml': `menu:\n  origin: http://127.0.0.1:${port}\n  version: local-test\n`,
    },
  });
});

afterAll(async () => {
  if (ctx) await ctx.close();
  if (mirror) await new Promise((resolve) => mirror.close(resolve));
});

describe('devgetbrowser on a flat-file mirror', () => {
  it('falls back to menu/latest instead of crashing on the HTML listing', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');

    const [args] = await Promise.all([
      once(socket, 'devrenderbrowser'),
      Promise.resolve(socket.emit('devgetbrowser')),
    ]);
    const releases = args[0];

    expect(releases).toHaveLength(1);
    expect(releases[0].tag_name).toBe('0.0.2');
    expect(releases[0].html_url).toContain('/menu/0.0.2/');
    socket.close();
  });
});