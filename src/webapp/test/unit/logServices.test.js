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
});
