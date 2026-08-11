// Integration tests: docs served from the fixture /docs volume — listing,
// tree building and markdown rendering.
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

describe('docs socket handlers', () => {
  it('lists docs as a tree', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');

    const [args] = await Promise.all([once(socket, 'docs:list:response'), Promise.resolve(socket.emit('docs:list'))]);
    const tree = args[0];
    expect(tree.index.__file).toBe('index.md');
    expect(tree.guides.advanced.__file).toBe('guides/advanced.md');
    socket.close();
  });

  it('renders a doc as HTML (marked)', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');

    const [args] = await Promise.all([
      once(socket, 'docs:get:response'),
      Promise.resolve(socket.emit('docs:get', 'index')),
    ]);
    const [{ filename, content }] = args;
    expect(filename).toBe('index');
    expect(content).toContain('<h1>Home</h1>');
    socket.close();
  });

  it('errors gracefully for a missing doc', async () => {
    const socket = ctx.connectClient({ auth: { token: PASS } });
    await once(socket, 'connect');

    const [args] = await Promise.all([
      once(socket, 'error'),
      Promise.resolve(socket.emit('docs:get', 'does-not-exist')),
    ]);
    expect(args[0]).toBe('Failed to read doc');
    socket.close();
  });
});
