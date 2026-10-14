import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile as execFileCallback, execFileSync } from 'child_process';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import { createFixtureRoot } from '../helpers/fixtures.js';

const require = createRequire(import.meta.url);
const toolServices = require('../../services/okdToolServices.js');
const { createToolService } = toolServices;
const RELEASE = '5.0.0-okd-scos.1';

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function archiveFixture({ binary = 'openshift-install', symlink = false } = {}) {
  const root = createFixtureRoot();
  const source = path.join(root, 'source');
  const archive = path.join(root, 'tool.tar.gz');
  fs.mkdirSync(source);
  if (symlink) {
    fs.writeFileSync(path.join(source, 'target'), 'binary');
    fs.symlinkSync('target', path.join(source, binary));
  } else {
    fs.writeFileSync(path.join(source, binary), 'fixture binary', { mode: 0o700 });
  }
  execFileSync('tar', ['-czf', archive, '-C', source, binary]);
  return { root, archive };
}

function record(archiveSha256, clientSha256 = archiveSha256) {
  return {
    revision: 'test-1', release: RELEASE, architecture: 'linux/amd64',
    releaseImage: 'quay.io/okd/scos-release@sha256:test', releaseDigest: 'sha256:test',
    releaseMetadataUrl: 'https://example.test/release.txt', checksumMetadataUrl: 'https://example.test/sha256sum.txt',
    tools: {
      installer: {
        required: true, binary: 'openshift-install', archive: 'openshift-install.tar.gz',
        archiveSha256, sourceUrl: 'https://example.test/openshift-install.tar.gz', maxBytes: 1024 * 1024,
      },
      oc: {
        required: false, binary: 'oc', archive: 'openshift-client.tar.gz',
        archiveSha256: clientSha256, sourceUrl: 'https://example.test/openshift-client.tar.gz', maxBytes: 1024 * 1024,
      },
    },
  };
}

function commandRunner(version = RELEASE) {
  return (command, args, options) => {
    if (command !== 'tar') return Promise.resolve({
      stdout: path.basename(command) === 'oc' ? `Client Version: ${version}\n` : `${command} ${version}\n`, stderr: '',
    });
    return new Promise((resolve, reject) => execFileCallback(command, args, options, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    }));
  };
}

function downloader(source, counter) {
  return async (_url, destination) => {
    if (counter) counter.count += 1;
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  };
}

function finalDir(configRoot) {
  return path.join(configRoot, 'okd', 'cache', 'sha256-test', 'installer');
}

describe('OKD exact tool preparation', () => {
  it('keeps generation unready until every required native helper is verified', async () => {
    const installer = archiveFixture(); const client = archiveFixture({ binary: 'oc' });
    const compatibility = record(checksum(installer.archive), checksum(client.archive));
    compatibility.tools.oc.required = true;
    const service = createToolService({ record: compatibility, configRoot: path.join(installer.root, 'config'),
      download: (url, destination) => downloader(url.includes('client') ? client.archive : installer.archive)(url, destination), run: commandRunner() });
    await service.prepare('installer');
    expect((await service.getStatus()).generationReady).toBe(false);
    await service.prepare('oc');
    expect((await service.getStatus()).generationReady).toBe(true);
  });
  it('exposes only the two pinned releases and rejects unknown releases', async () => {
    expect(toolServices.supportedReleases).toEqual(['4.22.0-okd-scos.9', '5.0.0-okd-scos.1']);
    await expect(toolServices.getToolStatus('4.22.0-okd-scos.9')).resolves.toMatchObject({
      release: '4.22.0-okd-scos.9', releaseDigest: 'sha256:ec8d6dc47890317f33f435200bd7b2de7746c84f2c3d3c39d38510fd9aec6833',
      tools: { installer: { ready: false }, oc: { ready: false } },
    });
    await expect(toolServices.getToolStatus('unknown')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(toolServices.installTools('unknown')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('installs and verifies both tools for one selected record', async () => {
    const installer = archiveFixture();
    const client = archiveFixture({ binary: 'oc' });
    const configRoot = path.join(installer.root, 'config');
    const downloaded = [];
    const service = createToolService({
      record: record(checksum(installer.archive), checksum(client.archive)), configRoot, run: commandRunner(),
      download: async (url, destination) => {
        downloaded.push(url);
        await fs.promises.copyFile(url.includes('client') ? client.archive : installer.archive, destination, fs.constants.COPYFILE_EXCL);
      },
    });
    const status = await service.installAll();
    expect(downloaded.sort()).toEqual(['https://example.test/openshift-client.tar.gz', 'https://example.test/openshift-install.tar.gz']);
    expect(status.tools).toMatchObject({ installer: { ready: true }, oc: { ready: true } });
    await service.installAll(); expect(downloaded).toHaveLength(2);
    const restarted = createToolService({ record: record(checksum(installer.archive), checksum(client.archive)), configRoot, run: commandRunner(),
      download: () => { throw new Error('Verified cache must not use the network'); } });
    expect(await restarted.getStatus()).toMatchObject({ state: 'ready', generationReady: true });
    expect(await restarted.installAll()).toMatchObject({ state: 'ready', tools: { installer: { ready: true }, oc: { ready: true } } });
  });

  it('shares exactly one release promise and exposes partial success until the failing sibling finishes', async () => {
    const fixture = archiveFixture(); let failClient; let clientStarted;
    const started = new Promise((resolve) => { clientStarted = resolve; });
    let commands = 0;
    const compatibility = record(checksum(fixture.archive)); compatibility.tools.oc.required = true;
    const service = createToolService({ record: compatibility, configRoot: path.join(fixture.root, 'config'),
      run: (...args) => { commands++; return commandRunner()(...args); },
      download: (url, destination) => url.includes('client') ? new Promise((_resolve, reject) => { failClient = reject; clientStarted(); }) : downloader(fixture.archive)(url, destination) });
    const work = service.installAll(); expect(service.installAll()).toBe(work); await started;
    await service.prepare('installer');
    const verifiedCommands = commands;
    expect(await service.getStatus()).toMatchObject({ state: 'preparing', generationReady: false, tools: { installer: { state: 'ready', ready: true }, oc: { state: 'preparing' } } });
    await service.getStatus(); await service.getStatus(); expect(commands).toBe(verifiedCommands);
    failClient(Object.assign(new Error('credential must not be returned'), { code: 'DOWNLOAD_FAILED' }));
    const result = await work;
    expect(result).toMatchObject({ state: 'failed', generationReady: false, tools: { installer: { state: 'ready', ready: true }, oc: { state: 'failed', code: 'DOWNLOAD_FAILED' } } });
    expect(JSON.stringify(result)).not.toContain('credential');
    const restarted = createToolService({ record: record(checksum(fixture.archive)), configRoot: path.join(fixture.root, 'config'), run: commandRunner() });
    expect((await restarted.getStatus()).tools.oc.state).toBe('missing');
  });

  it('rejects an archive checksum mismatch without promoting cache content', async () => {
    const fixture = archiveFixture();
    const configRoot = path.join(fixture.root, 'config');
    const service = createToolService({ record: record('0'.repeat(64)), configRoot, download: downloader(fixture.archive), run: commandRunner() });
    await expect(service.prepare('installer')).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(fs.existsSync(finalDir(configRoot))).toBe(false);
  });

  it('rejects symlink extraction and exact-version mismatch without promotion', async () => {
    const unsafe = archiveFixture({ symlink: true });
    const unsafeRoot = path.join(unsafe.root, 'config');
    await expect(createToolService({ record: record(checksum(unsafe.archive)), configRoot: unsafeRoot, download: downloader(unsafe.archive), run: commandRunner() }).prepare('installer'))
      .rejects.toMatchObject({ code: 'UNSAFE_ARCHIVE' });
    expect(fs.existsSync(finalDir(unsafeRoot))).toBe(false);

    const wrong = archiveFixture();
    const wrongRoot = path.join(wrong.root, 'config');
    await expect(createToolService({ record: record(checksum(wrong.archive)), configRoot: wrongRoot, download: downloader(wrong.archive), run: commandRunner('5.0.0-okd-scos.0') }).prepare('installer'))
      .rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    expect(fs.existsSync(finalDir(wrongRoot))).toBe(false);
  });

  it('reports version execution failures safely without promoting cache content', async () => {
    const fixture = archiveFixture();
    const configRoot = path.join(fixture.root, 'config');
    const run = (command, args, options) => command === 'tar'
      ? commandRunner()(command, args, options)
      : Promise.reject(Object.assign(new Error('spawn /secret/cache/openshift-install ENOENT'), { code: 'ENOENT', stderr: 'private runtime details' }));
    const service = createToolService({ record: record(checksum(fixture.archive)), configRoot, download: downloader(fixture.archive), run });

    await expect(service.prepare('installer')).rejects.toMatchObject({
      code: 'EXECUTION_FAILED',
      message: 'Prepared installer could not execute: its required runtime is unavailable.',
    });
    expect(fs.existsSync(finalDir(configRoot))).toBe(false);
  });

  it('promotes one verified preparation atomically, records binary checksum, and reuses it', async () => {
    const fixture = archiveFixture();
    const configRoot = path.join(fixture.root, 'config');
    const count = { count: 0 };
    const service = createToolService({
      record: record(checksum(fixture.archive)), configRoot, download: downloader(fixture.archive, count),
      run: commandRunner(), now: () => '2026-10-13T00:00:00.000Z',
    });
    await expect(service.getVerifiedInstaller()).rejects.toMatchObject({ code: 'INSTALLER_NOT_READY' });
    const [first, concurrent] = await Promise.all([service.prepare('installer'), service.prepare('installer')]);
    expect(first.ready).toBe(true);
    expect(concurrent.metadata.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(count.count).toBe(1);
    expect(fs.readdirSync(finalDir(configRoot)).sort()).toEqual(['metadata.json', 'openshift-install']);
    expect(fs.readdirSync(path.dirname(finalDir(configRoot)))).toEqual(['installer']);
    const readyStatus = await service.getStatus();
    expect(readyStatus.generationReady).toBe(true);
    expect(readyStatus.tools.installer.binaryPath).toBe(path.join(finalDir(configRoot), 'openshift-install'));
    expect(await service.getVerifiedInstaller()).toMatchObject({ path: path.join(finalDir(configRoot), 'openshift-install'), metadata: { binarySha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    await service.prepare('installer');
    expect(count.count).toBe(1);

    fs.appendFileSync(path.join(finalDir(configRoot), 'openshift-install'), 'tampered');
    expect((await service.getStatus()).tools.installer).toMatchObject({ ready: false, code: 'CACHE_INVALID' });
    expect((await service.getStatus()).tools.installer).not.toHaveProperty('binaryPath');
    await expect(service.getVerifiedInstaller()).rejects.toMatchObject({ code: 'INSTALLER_NOT_READY' });
  });

  it('refuses a symlinked cache path', async () => {
    const fixture = archiveFixture();
    const configRoot = path.join(fixture.root, 'config');
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(path.join(configRoot, 'okd'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(configRoot, 'okd', 'cache'), 'dir');
    const service = createToolService({ record: record(checksum(fixture.archive)), configRoot, download: downloader(fixture.archive), run: commandRunner() });
    await expect(service.prepare('installer')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
