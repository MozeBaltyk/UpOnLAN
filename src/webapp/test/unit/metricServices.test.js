// Unit tests: TFTP request counting (the "boot activity" business metric).
import { describe, expect, it } from 'vitest';
import { parseTftpRequestsFromLog, computeNginxDeltas } from '../../services/metricServices.js';

describe('metricServices.parseTftpRequestsFromLog', () => {
  it('counts dnsmasq TFTP transfer lines', () => {
    const log = [
      'dnsmasq[40]: started, version 2.90 DNS disabled',
      'dnsmasq-tftp[40]: TFTP root is /config/menus secure mode single port mode',
      'dnsmasq-tftp[40]: sent /config/menus/menu.ipxe to 10.89.0.1',
      'dnsmasq-tftp[40]: sent /config/menus/boot.cfg to 10.89.0.1',
      'dnsmasq-tftp[40]: file /config/menus/nope.ipxe not found',
    ].join('\n');
    expect(parseTftpRequestsFromLog(log)).toBe(2);
  });

  it('counts transfers with a syslog timestamp prefix', () => {
    const log = [
      'Aug 18 22:46:59 dnsmasq-tftp[40]: sent /config/menus/menu.ipxe to 10.89.0.1',
      'Aug 18 22:47:32 dnsmasq-tftp[40]: sent /config/menus/netinfo.ipxe to 10.89.0.1',
    ].join('\n');
    expect(parseTftpRequestsFromLog(log)).toBe(2);
  });

  it('counts tftp-hpa RRQ/WRQ lines (daemon-agnostic)', () => {
    const log = [
      'tftpd[1]: RRQ from 10.0.0.1 for example.ipxe',
      'tftpd[2]: WRQ from 10.0.0.2 for upload',
      'tftpd[3]: RRQ from 10.0.0.3 for other.ipxe',
    ].join('\n');
    expect(parseTftpRequestsFromLog(log)).toBe(3);
  });

  it('ignores non-transfer lines and empty input', () => {
    expect(parseTftpRequestsFromLog('nothing here\nnor here')).toBe(0);
    expect(parseTftpRequestsFromLog('')).toBe(0);
  });
});

describe('metricServices.computeNginxDeltas', () => {
  it('reports zero activity on the first sample (no baseline)', () => {
    expect(computeNginxDeltas(null, { accepts: 100, handled: 100, requests: 50, active: 3, timestamp: 1 }))
      .toEqual({ accepts: 0, handled: 0, requests: 0, active: 3, timestamp: 1 });
  });

  it('computes deltas between consecutive samples', () => {
    const prev = { accepts: 100, handled: 90, requests: 50, timestamp: 1 };
    expect(computeNginxDeltas(prev, { accepts: 130, handled: 110, requests: 70, active: 4, timestamp: 2 }))
      .toEqual({ accepts: 30, handled: 20, requests: 20, active: 4, timestamp: 2 });
  });

  it('re-baselines after a counter reset (nginx reload/restart) instead of emitting a spike', () => {
    const prev = { accepts: 130, handled: 110, requests: 70, timestamp: 2 };
    expect(computeNginxDeltas(prev, { accepts: 5, handled: 5, requests: 3, active: 1, timestamp: 3 }))
      .toEqual({ accepts: 0, handled: 0, requests: 0, active: 1, timestamp: 3 });
  });
});
