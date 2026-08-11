// Unit tests: WoL business rules (MAC validation, dedup, wake safety).
// Real fixture config file, no mocks — only the shell exec is avoided by
// testing the validation paths, which fail before exec is ever reached.
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFixtureRoot } from '../helpers/fixtures.js';

let wol;

beforeAll(async () => {
  const root = createFixtureRoot();
  process.env.UPONLAN_CONFIG = path.join(root, 'config');
  wol = (await import('../../services/wolServices.js')).default;
});

describe('wolServices.addWolEntry', () => {
  it('rejects an invalid MAC address', () => {
    expect(() => wol.addWolEntry({ default_mac: 'not-a-mac' })).toThrow('Invalid MAC address');
  });

  it('rejects a shell payload as MAC', () => {
    expect(() => wol.addWolEntry({ default_mac: '00:11:22:33:44:55; rm -rf /' })).toThrow('Invalid MAC address');
  });

  it('rejects a duplicate MAC (case-insensitive)', () => {
    // fixture wol.yml already contains 00:11:22:33:44:55
    expect(() => wol.addWolEntry({ default_mac: '00:11:22:33:44:55' })).toThrow('MAC address already exists');
    expect(() => wol.addWolEntry({ default_mac: '00:11:22:33:44:55'.toUpperCase() })).toThrow('MAC address already exists');
  });

  it('persists a valid new entry to wol.yml', () => {
    const data = wol.addWolEntry({ default_mac: 'AA:BB:CC:DD:EE:FF', name: 'New host' });
    expect(data.wakeonlan).toHaveLength(2);
    expect(wol.getWolEntries().wakeonlan.map((e) => e.default_mac)).toContain('AA:BB:CC:DD:EE:FF');
    // cleanup so the shared fixture stays pristine for other tests in this file
    wol.deleteWolEntry('AA:BB:CC:DD:EE:FF');
  });
});

describe('wolServices.deleteWolEntry', () => {
  it('throws when the entry does not exist', () => {
    expect(() => wol.deleteWolEntry('00:00:00:00:00:00')).toThrow('Entry not found');
  });
});

describe('wolServices.wakeHost', () => {
  it('rejects injection payloads without touching the shell', async () => {
    for (const mac of ['00:11:22:33:44:55; rm -rf /', '$(reboot)', 'x'.repeat(17), '../etc/passwd', null, undefined]) {
      const err = await new Promise((resolve) => wol.wakeHost(mac, (e) => resolve(e)));
      expect(err && err.message).toBe('Invalid MAC address');
    }
  });

  it('passes a valid MAC through to exec (error must NOT be validation-related)', async () => {
    // `awake` binary may not exist on the test host; the point is the
    // validation gate accepted the MAC and exec was attempted.
    const err = await new Promise((resolve) => wol.wakeHost('00:11:22:33:44:55', (e) => resolve(e)));
    expect(!err || err.message).not.toBe('Invalid MAC address');
  });
});
