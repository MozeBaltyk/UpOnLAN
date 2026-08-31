import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, once } from '../helpers/bootApp.js';

const PASS = 'secret';

let ctx;

beforeAll(async () => {
  ctx = await bootApp({
    pass: PASS,
    fixtures: {
      'config/provisioning/local/rocky/base/ks.cfg': '# kickstart\n',
      'config/provisioning/local/ubuntu/lab/user-data': '#cloud-config\n',
      'config/provisioning/local/ubuntu/lab/meta-data': 'instance-id: lab\nlocal-hostname: lab\n',
    },
  });
});

afterAll(async () => {
  if (ctx) await ctx.close();
});

async function authedSocket() {
  const socket = ctx.connectClient({ auth: { token: PASS } });
  await once(socket, 'connect');
  return socket;
}

describe('provisioning socket handlers', () => {
  it('lists provisioning files from disk', async () => {
    const socket = await authedSocket();
    const [[files]] = await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('getprovisioning')),
    ]);
    expect(files).toEqual(expect.arrayContaining([
      'rocky/base/ks.cfg',
      'ubuntu/lab/meta-data',
      'ubuntu/lab/user-data',
    ]));
    socket.close();
  });

  it('reads a provisioning file for editing', async () => {
    const socket = await authedSocket();
    const [content, relativePath] = await Promise.all([
      once(socket, 'renderprovisioningfile'),
      Promise.resolve(socket.emit('getprovisioningfile', 'rocky/base/ks.cfg')),
    ]).then(([args]) => args);
    expect(relativePath).toBe('rocky/base/ks.cfg');
    expect(content).toBe('# kickstart\n');
    socket.close();
  });

  it('can open a published provisioning asset in the editor by seeding a local copy', async () => {
    const assetPath = path.join(ctx.root, 'assets', 'provisioning', 'kickstart', 'published-only', 'ks.cfg');
    const configPath = path.join(ctx.root, 'config', 'provisioning', 'local', 'kickstart', 'published-only', 'ks.cfg');
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, 'lang en_US.UTF-8\n', 'utf8');
    expect(fs.existsSync(configPath)).toBe(false);

    const socket = await authedSocket();
    const [content, relativePath] = await Promise.all([
      once(socket, 'renderprovisioningfile'),
      Promise.resolve(socket.emit('getprovisioningfile', 'kickstart/published-only/ks.cfg')),
    ]).then(([args]) => args);

    expect(relativePath).toBe('kickstart/published-only/ks.cfg');
    expect(content).toBe('lang en_US.UTF-8\n');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('lang en_US.UTF-8\n');
    socket.close();
  });

  it('saves a provisioning file and publishes it under /assets/provisioning', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('saveprovisioningfile', 'rocky/base/ks.cfg', 'lang en_US.UTF-8\n')),
    ]);
    const configPath = path.join(ctx.root, 'config', 'provisioning', 'local', 'rocky', 'base', 'ks.cfg');
    const assetPath = path.join(ctx.root, 'assets', 'provisioning', 'rocky', 'base', 'ks.cfg');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('lang en_US.UTF-8\n');
    expect(fs.readFileSync(assetPath, 'utf8')).toBe('lang en_US.UTF-8\n');
    socket.close();
  });

  it('deletes a local provisioning file and its published asset copy', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('saveprovisioningfile', 'rocky/delete-me/ks.cfg', 'lang en_US.UTF-8\n')),
    ]);

    const configPath = path.join(ctx.root, 'config', 'provisioning', 'local', 'rocky', 'delete-me', 'ks.cfg');
    const assetPath = path.join(ctx.root, 'assets', 'provisioning', 'rocky', 'delete-me', 'ks.cfg');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(assetPath)).toBe(true);

    const [[files]] = await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('deleteprovisioningfile', 'rocky/delete-me/ks.cfg')),
    ]);
    expect(files).not.toContain('rocky/delete-me/ks.cfg');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(assetPath)).toBe(false);
    socket.close();
  });

  it('creates a Kickstart profile and publishes ks.cfg', async () => {
    const socket = await authedSocket();
    const [[files]] = await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('createkickstart', 'rocky/new-profile')),
    ]);
    const configPath = path.join(ctx.root, 'config', 'provisioning', 'local', 'rocky', 'new-profile', 'ks.cfg');
    const assetPath = path.join(ctx.root, 'assets', 'provisioning', 'rocky', 'new-profile', 'ks.cfg');
    expect(files).toContain('rocky/new-profile/ks.cfg');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(assetPath)).toBe(true);
    socket.close();
  });

  it('creates a cloud-init profile and publishes user-data + meta-data', async () => {
    const socket = await authedSocket();
    const [[files]] = await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('createcloudinit', 'ubuntu/new-seed')),
    ]);
    const userDataPath = path.join(ctx.root, 'config', 'provisioning', 'local', 'ubuntu', 'new-seed', 'user-data');
    const metaDataPath = path.join(ctx.root, 'config', 'provisioning', 'local', 'ubuntu', 'new-seed', 'meta-data');
    const assetUserDataPath = path.join(ctx.root, 'assets', 'provisioning', 'ubuntu', 'new-seed', 'user-data');
    const assetMetaDataPath = path.join(ctx.root, 'assets', 'provisioning', 'ubuntu', 'new-seed', 'meta-data');
    expect(files).toEqual(expect.arrayContaining([
      'ubuntu/new-seed/meta-data',
      'ubuntu/new-seed/user-data',
    ]));
    expect(fs.readFileSync(userDataPath, 'utf8')).toBe('#cloud-config\nusers:\n  - name: ubuntu\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n');
    expect(fs.readFileSync(metaDataPath, 'utf8')).toContain('instance-id: new-seed');
    expect(fs.existsSync(assetUserDataPath)).toBe(true);
    expect(fs.existsSync(assetMetaDataPath)).toBe(true);
    socket.close();
  });

  it('stores and returns a per-profile version', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('saveprovisioningversion', 'rocky/base/ks.cfg', '9')),
    ]);
    const [content, relativePath, version] = await Promise.all([
      once(socket, 'renderprovisioningfile'),
      Promise.resolve(socket.emit('getprovisioningfile', 'rocky/base/ks.cfg')),
    ]).then(([args]) => args);
    expect(relativePath).toBe('rocky/base/ks.cfg');
    expect(version).toBe('9');
    socket.close();
  });

  it('validates meta-data YAML syntax without external tools', async () => {
    const socket = await authedSocket();
    const [relativePath, result] = await Promise.all([
      once(socket, 'renderprovisioningvalidation'),
      Promise.resolve(socket.emit('validateprovisioning', 'ubuntu/lab/meta-data', '')),
    ]).then(([args]) => args);
    expect(relativePath).toBe('ubuntu/lab/meta-data');
    expect(result.ok).toBe(true);
    socket.close();
  });

  it('reports a YAML syntax error for invalid meta-data', async () => {
    const socket = await authedSocket();
    await Promise.all([
      once(socket, 'renderprovisioning'),
      Promise.resolve(socket.emit('saveprovisioningfile', 'ubuntu/lab/meta-data', 'instance-id: [unclosed\n')),
    ]);
    const [relativePath, result] = await Promise.all([
      once(socket, 'renderprovisioningvalidation'),
      Promise.resolve(socket.emit('validateprovisioning', 'ubuntu/lab/meta-data', '')),
    ]).then(([args]) => args);
    expect(relativePath).toBe('ubuntu/lab/meta-data');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('YAML syntax error');
    socket.close();
  });

  it('rejects directory traversal and invalid file names', async () => {
    const socket = await authedSocket();
    const [traversal] = await Promise.all([
      once(socket, 'error').then((args) => args),
      Promise.resolve(socket.emit('getprovisioningfile', '../../etc/passwd')),
    ]);
    expect(traversal[0]).toBe('Invalid provisioning path');

    const [invalidName] = await Promise.all([
      once(socket, 'error').then((args) => args),
      Promise.resolve(socket.emit('saveprovisioningfile', 'rocky/base/not-allowed.txt', 'nope\n')),
    ]);
    expect(invalidName[0]).toBe('Invalid provisioning path');
    socket.close();
  });
});
