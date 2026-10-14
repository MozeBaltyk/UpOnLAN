// Unit tests for the ROM build runner: progress streaming, single-flight guard,
// and cancel. The build script is stubbed via UPONLAN_ROM_BUILD_SCRIPT so these
// tests never shell out to the real iPXE build.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp;

async function loadService(scriptContent) {
  vi.resetModules();
  const scriptPath = path.join(tmp, 'build.sh');
  const manifestHelper = path.join(tmp, 'manifest.js');
  fs.writeFileSync(manifestHelper, `
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const sets={legacy:['uponlan.xyz.kpxe','uponlan.xyz.dsk','uponlan.xyz.pdsk','uponlan.xyz.lkrn','uponlan.xyz-undionly.kpxe'],efi:['uponlan.xyz.efi','uponlan.xyz-snp.efi','uponlan.xyz-snponly.efi'],iso:['uponlan.xyz.iso'],usb:['uponlan.xyz.img'],release:['uponlan.xyz-undionly.kpxe','uponlan.xyz.kpxe','uponlan.xyz.efi']};
const names=[...new Set((process.argv[2]||'release').split(',').flatMap(x=>sets[x]))].sort(),root=process.env.OUT_ROM;fs.mkdirSync(root,{recursive:true});
const files=names.map(name=>{const b=Buffer.from(name);fs.writeFileSync(path.join(root,name),b);return{name,size:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}});
fs.writeFileSync(path.join(root,'build-manifest.json'),JSON.stringify({schemaVersion:1,ipxeVersion:'1.21.1',builtAt:'2026-01-01T00:00:00Z',trustSha256:null,files}));
`);
  fs.writeFileSync(scriptPath, `${scriptContent}\nnode "${manifestHelper}" "$1"\n`, { mode: 0o755 });
  process.env.UPONLAN_ROM_BUILD_SCRIPT = scriptPath;
  process.env.UPONLAN_CONFIG = path.join(tmp, 'config');
  process.env.UPONLAN_LOGS = path.join(tmp, 'logs');
  return (await import('../../services/romBuildService.js'));
}

const socket = { id: 'test-socket', emit: () => {} };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rombuild-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
  delete process.env.UPONLAN_ROM_BUILD_SCRIPT;
  delete process.env.UPONLAN_CONFIG;
  delete process.env.UPONLAN_LOGS;
  delete process.env.UPONLAN_ROM_CANCEL_TIMEOUT_MS;
  delete process.env.WEBAPP_USER; delete process.env.WEBAPP_PASS; delete process.env.UNRELATED_SECRET;
});

describe('romBuildService', () => {
  it('streams [ipxe] lines as progress and resolves success', async () => {
    const svc = await loadService(
      '#!/bin/bash\necho "[ipxe] fetching iPXE"\necho "[ipxe] building"\necho "[ipxe] done"\n',
    );
    const progress = [];
    const result = await svc.startBuild('legacy,efi', socket, (p) => progress.push(p));
    expect(result.success).toBe(true);

    const final = await result.promise;
    expect(final.success).toBe(true);
    expect(final.status).toBe('success');
    expect(progress.map((p) => p.currentTask)).toEqual(['fetching iPXE', 'building', 'done']);
    expect(progress[0].taskCount).toBeGreaterThan(0);
  });

  it('blocks a second build while one is running', async () => {
    const svc = await loadService('#!/bin/bash\nsleep 1\n');
    const first = await svc.startBuild('efi', socket, () => {});
    const second = await svc.startBuild('efi', socket, () => {});
    expect(second.success).toBe(false);
    expect(second.message).toMatch(/already running/);
    await first.promise;
  });

  it('reserves build state before simultaneous starts can race', async () => {
    const svc = await loadService('#!/bin/bash\nsleep 0.1\n');
    const results = await Promise.all([svc.startBuild('efi', socket, () => {}), svc.startBuild('efi', socket, () => {})]);
    expect(results.filter((result) => result.success)).toHaveLength(1); expect(results.filter((result) => !result.success)[0].message).toMatch(/already running/);
    await results.find((result) => result.success).promise;
  });

  it('passes only allowlisted build environment values', async () => {
    process.env.WEBAPP_USER = 'operator'; process.env.WEBAPP_PASS = 'secret'; process.env.UNRELATED_SECRET = 'private';
    const svc = await loadService('#!/bin/bash\nmkdir -p "$OUT_ROM"\nenv > "$OUT_ROM/child-env"\n');
    const result = await svc.startBuild('efi', socket, () => {}); await result.promise;
    const env = fs.readFileSync(path.join(tmp, 'config/menus/rom/ipxe/child-env'), 'utf8');
    expect(env).toContain('OUT_ROM='); expect(env).not.toMatch(/WEBAPP_USER|WEBAPP_PASS|UNRELATED_SECRET|operator|secret|private/);
  });

  it('cancelBuild SIGTERMs the running build and reports cancelled', async () => {
    const svc = await loadService('#!/bin/bash\nsleep 30\n');
    const result = await svc.startBuild('efi', socket, () => {});
    expect(result.success).toBe(true);

    const cancelled = await svc.cancelBuild();
    expect(cancelled.success).toBe(false);
    expect(cancelled.status).toBe('cancelled');
  });

  it('escalates cancellation to bounded SIGKILL when TERM is ignored', async () => {
    process.env.UPONLAN_ROM_CANCEL_TIMEOUT_MS = '10';
    const svc = await loadService("#!/bin/bash\ntrap '' TERM\nwhile :; do sleep 1; done\n");
    const result = await svc.startBuild('efi', socket, () => {});
    const cancelled = await svc.cancelBuild();
    expect(cancelled).toMatchObject({ success: false, status: 'cancelled' }); await result.promise;
  });

  it('reports a non-zero exit as an error', async () => {
    const svc = await loadService('#!/bin/bash\necho "[ipxe] about to fail"\nexit 3\n');
    const result = await svc.startBuild('efi', socket, () => {});
    const final = await result.promise;
    expect(final.success).toBe(false);
    expect(final.status).toBe('error');
    expect(final.message).toMatch(/code 3/);
  });

  it('consumes asynchronous spawn errors and clears build state', async () => {
    const svc = await loadService('#!/bin/bash\nexit 0\n'); fs.unlinkSync(process.env.UPONLAN_ROM_BUILD_SCRIPT);
    const result = await svc.startBuild('efi', socket, () => {}); expect(result.success).toBe(true);
    await expect(result.promise).resolves.toMatchObject({ success: false, status: 'error' });
    const next = await svc.startBuild('efi', socket, () => {}); expect(next.success).toBe(true); await next.promise;
  });

  it('rejects a zero-exit build that does not publish a valid manifest', async () => {
    const svc = await loadService('#!/bin/bash\nexit 0\n');
    const result = await svc.startBuild('efi', socket, () => {});
    const final = await result.promise;
    expect(final.success).toBe(false);
    expect(final.message).toMatch(/manifest/i);
  });
});
