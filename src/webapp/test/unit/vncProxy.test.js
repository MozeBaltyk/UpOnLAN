// Unit tests: VNC token minting/validation (the auth gate for /novnc/ws).
import { describe, expect, it, vi } from 'vitest';

const vncProxy = await import('../../sockets/vncProxy.js');

describe('vncProxy tokens', () => {
  it('mints a token that validates exactly once', () => {
    const t = vncProxy.mintVncToken();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(8);
    expect(vncProxy.isValidVncToken(t)).toBe(true);
    expect(vncProxy.isValidVncToken(t)).toBe(true); // reusable within TTL
  });

  it('rejects missing/garbage tokens', () => {
    expect(vncProxy.isValidVncToken(undefined)).toBe(false);
    expect(vncProxy.isValidVncToken('')).toBe(false);
    expect(vncProxy.isValidVncToken('deadbeef')).toBe(false);
    expect(vncProxy.isValidVncToken(123)).toBe(false);
  });

  it('expires tokens after the TTL', () => {
    vi.useFakeTimers();
    try {
      const t = vncProxy.mintVncToken();
      expect(vncProxy.isValidVncToken(t)).toBe(true);
      vi.advanceTimersByTime(61_000);
      expect(vncProxy.isValidVncToken(t)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
