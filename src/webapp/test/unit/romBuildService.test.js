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
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
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

  it('cancelBuild SIGTERMs the running build and reports cancelled', async () => {
    const svc = await loadService('#!/bin/bash\nsleep 30\n');
    const result = await svc.startBuild('efi', socket, () => {});
    expect(result.success).toBe(true);

    const cancelled = await svc.cancelBuild();
    expect(cancelled.success).toBe(false);
    expect(cancelled.status).toBe('cancelled');
  });

  it('reports a non-zero exit as an error', async () => {
    const svc = await loadService('#!/bin/bash\necho "[ipxe] about to fail"\nexit 3\n');
    const result = await svc.startBuild('efi', socket, () => {});
    const final = await result.promise;
    expect(final.success).toBe(false);
    expect(final.status).toBe('error');
    expect(final.message).toMatch(/code 3/);
  });
});
