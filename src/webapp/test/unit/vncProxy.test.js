// Unit tests: VNC token minting/validation (the auth gate for /novnc/ws).
import { describe, expect, it, vi } from 'vitest';

const vncProxy = await import('../../sockets/vncProxy.js');

describe('vncProxy tokens', () => {
  it('mints a token that validates exactly once', () => {
    const t = vncProxy.mintVncToken(5901);
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(8);
    expect(vncProxy.isValidVncToken(t, 5901)).toBe(true);
    expect(vncProxy.isValidVncToken(t, 5901)).toBe(false);
  });

  it('binds a token to the port it was minted for', () => {
    const t = vncProxy.mintVncToken(5902);
    expect(vncProxy.isValidVncToken(t, 5903)).toBe(false);
    expect(vncProxy.isValidVncToken(t, 5902)).toBe(true);
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
      const t = vncProxy.mintVncToken(5900);
      vi.advanceTimersByTime(61_000);
      expect(vncProxy.isValidVncToken(t, 5900)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('vncProxy port restriction', () => {
  it('allows only the VNC display range', () => {
    expect(vncProxy.isAllowedVncPort(5900)).toBe(true);
    expect(vncProxy.isAllowedVncPort(5905)).toBe(true);
    expect(vncProxy.isAllowedVncPort(5999)).toBe(true);
  });

  it('rejects arbitrary host ports', () => {
    for (const port of [0, 22, 80, 443, 3306, 5899, 6000, 65535, NaN, '5900']) {
      expect(vncProxy.isAllowedVncPort(port)).toBe(false);
    }
  });
});
