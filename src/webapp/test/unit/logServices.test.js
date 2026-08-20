// Unit tests: log file access degrades gracefully (no crash, friendly message).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

let logRoot;

beforeAll(async () => {
  logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uponlan-logs-'));
  process.env.UPONLAN_LOGS = logRoot;
});

describe('logServices', () => {
  let logServices;
  beforeAll(async () => {
    logServices = (await import('../../services/logServices.js')).default;
  });

  it('returns a friendly message for a missing log file', () => {
    expect(logServices.getWebLog()).toBe('Log file not found or unreadable.');
    expect(logServices.getTftpLog()).toBe('Log file not found or unreadable.');
    expect(logServices.getNginxErrorLog()).toBe('error.log not found or unreadable.');
  });

  it('reads an existing log file', () => {
    fs.mkdirSync(path.join(logRoot, 'webapp'), { recursive: true });
    fs.writeFileSync(path.join(logRoot, 'webapp', 'webapp.log'), 'hello from webapp\n');
    expect(logServices.getWebLog()).toBe('hello from webapp\n');
  });

  it('returns a friendly message when no ROM build logs exist', () => {
    expect(logServices.getRomBuildLog()).toBe('No ROM build logs yet.');
  });

  it('returns the most recent ROM build log with its filename', () => {
    const romDir = path.join(logRoot, 'rom');
    fs.mkdirSync(romDir, { recursive: true });
    fs.writeFileSync(path.join(romDir, 'build_2026-08-19T13-08-06-725Z.log'), 'first build\n');
    fs.writeFileSync(path.join(romDir, 'build_2026-08-19T13-28-10-557Z.log'), 'second build\n');
    const log = logServices.getRomBuildLog();
    expect(log).toContain('build_2026-08-19T13-28-10-557Z.log');
    expect(log).toContain('second build');
    expect(log).not.toContain('first build');
  });
});
