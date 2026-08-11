// Unit tests: TFTP request counting (the "boot activity" business metric).
import { describe, expect, it } from 'vitest';
import { parseTftpRequestsFromLog } from '../../services/metricServices.js';

describe('metricServices.parseTftpRequestsFromLog', () => {
  it('counts RRQ and WRQ lines', () => {
    const log = [
      'tftpd[1]: RRQ from 10.0.0.1 for example.ipxe',
      'tftpd[2]: WRQ from 10.0.0.2 for upload',
      'tftpd[3]: completed transfer',
      'tftpd[4]: RRQ from 10.0.0.3 for other.ipxe',
    ].join('\n');
    expect(parseTftpRequestsFromLog(log)).toBe(3);
  });

  it('ignores non-request lines and empty input', () => {
    expect(parseTftpRequestsFromLog('nothing here\nnor here')).toBe(0);
    expect(parseTftpRequestsFromLog('')).toBe(0);
  });
});
