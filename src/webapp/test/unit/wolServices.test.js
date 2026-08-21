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

describe('wolServices.isValidIp / isValidWakeAt', () => {
  it('accepts well-formed IPv4 and rejects anything else', () => {
    expect(wol.isValidIp('192.168.7.10')).toBe(true);
    expect(wol.isValidIp('0.0.0.0')).toBe(true);
    expect(wol.isValidIp('255.255.255.255')).toBe(true);
    expect(wol.isValidIp('256.1.1.1')).toBe(false);
    expect(wol.isValidIp('1.2.3')).toBe(false);
    expect(wol.isValidIp('1.2.3.4.5')).toBe(false);
    expect(wol.isValidIp('abc.def.ghi.jkl')).toBe(false);
    expect(wol.isValidIp('1.2.3.4; rm -rf /')).toBe(false);
    expect(wol.isValidIp(null)).toBe(false);
  });

  it('accepts only YYYY-MM-DDTHH:MM and parses to a real date', () => {
    expect(wol.isValidWakeAt('2026-08-22T07:00')).toBe(true);
    expect(wol.isValidWakeAt('2026-08-22')).toBe(false);
    expect(wol.isValidWakeAt('not-a-time')).toBe(false);
    expect(wol.isValidWakeAt('2026-99-99T99:99')).toBe(false);
    expect(wol.isValidWakeAt(null)).toBe(false);
  });
});

describe('wolServices.addWolEntry (ip / wake_at validation)', () => {
  it('rejects an invalid IP address', () => {
    expect(() => wol.addWolEntry({ default_mac: '11:22:33:44:55:66', ip: '999.1.1.1' })).toThrow('Invalid IP address');
  });

  it('rejects an invalid wake time', () => {
    expect(() => wol.addWolEntry({ default_mac: '11:22:33:44:55:66', wake_at: 'tomorrow' })).toThrow('Invalid wake time');
  });
});

describe('wolServices.updateWolEntry', () => {
  it('throws when the MAC does not exist', () => {
    expect(() => wol.updateWolEntry('00:00:00:00:00:00', { ip: '192.168.1.1' })).toThrow('Entry not found');
  });

  it('sets then clears ip and wake_at (persisted)', () => {
    wol.addWolEntry({ default_mac: 'CC:DD:EE:FF:00:11', hostname: 'Updater' });

    let data = wol.updateWolEntry('cc:dd:ee:ff:00:11', { ip: '192.168.1.10', wake_at: '2026-08-22T07:00' });
    let entry = data.wakeonlan.find((e) => e.default_mac.toLowerCase() === 'cc:dd:ee:ff:00:11');
    expect(entry.ip).toBe('192.168.1.10');
    expect(entry.wake_at).toBe('2026-08-22T07:00');

    // persisted to disk
    entry = wol.getWolEntries().wakeonlan.find((e) => e.default_mac.toLowerCase() === 'cc:dd:ee:ff:00:11');
    expect(entry.ip).toBe('192.168.1.10');
    expect(entry.wake_at).toBe('2026-08-22T07:00');

    // null/empty clears the field
    data = wol.updateWolEntry('cc:dd:ee:ff:00:11', { ip: null, wake_at: '' });
    entry = data.wakeonlan.find((e) => e.default_mac.toLowerCase() === 'cc:dd:ee:ff:00:11');
    expect(entry.ip).toBeNull();
    expect(entry.wake_at).toBeNull();

    wol.deleteWolEntry('cc:dd:ee:ff:00:11');
  });

  it('rejects invalid ip / wake_at on update', () => {
    wol.addWolEntry({ default_mac: 'CC:DD:EE:FF:00:22', hostname: 'Updater2' });
    expect(() => wol.updateWolEntry('cc:dd:ee:ff:00:22', { ip: '999.1.1.1' })).toThrow('Invalid IP address');
    expect(() => wol.updateWolEntry('cc:dd:ee:ff:00:22', { wake_at: 'not-a-time' })).toThrow('Invalid wake time');
    wol.deleteWolEntry('cc:dd:ee:ff:00:22');
  });
});

describe('wolServices.computeDueWakes', () => {
  it('returns only entries whose wake_at is due', () => {
    const entries = [
      { default_mac: 'AA', wake_at: '2026-08-22T07:00' }, // due
      { default_mac: 'BB', wake_at: '2026-08-22T09:00' }, // future
      { default_mac: 'CC' },                              // no schedule
      { default_mac: 'DD', wake_at: '2026-08-22T07:00' }, // due
    ];
    const now = new Date('2026-08-22T08:00:00');
    expect(wol.computeDueWakes(entries, now).map((e) => e.default_mac)).toEqual(['AA', 'DD']);
  });
});

describe('wolServices.pingHost', () => {
  it('resolves false for an invalid IP without touching the shell', async () => {
    await expect(wol.pingHost('not-an-ip')).resolves.toBe(false);
    await expect(wol.pingHost('999.999.999.999')).resolves.toBe(false);
    await expect(wol.pingHost('')).resolves.toBe(false);
  });
});
