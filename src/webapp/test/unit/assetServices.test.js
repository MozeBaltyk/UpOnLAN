// Unit tests: resolveSource maps a requested asset path to its on-demand
// vendor source URL from the endpoints catalog. Pure logic, no server.
import { describe, expect, it } from 'vitest';
import { resolveSource } from '../../services/assetServices.js';

const endpoints = {
  'talos-v1.13.8-x86_64': {
    path: '/assets/talos-v1.13.8-x86_64/',
    files: ['vmlinuz', 'initrd'],
    sources: ['https://vendor.example/vmlinuz-amd64', 'https://vendor.example/initramfs-amd64.xz'],
    build_type: 'direct_file',
  },
  'oracle-8-x86_64': {
    path: '/releases/download/oracle-8-x86_64/',
    files: ['vmlinuz', 'initrd'],
    // iso_extraction entries carry ISO-internal paths, never vendor URLs.
    sources: ['images/pxeboot/vmlinuz', 'images/pxeboot/initrd'],
    build_type: 'iso_extraction',
  },
};

describe('assetServices.resolveSource', () => {
  it('resolves a direct_file path to its aligned vendor source', () => {
    expect(resolveSource('/assets/talos-v1.13.8-x86_64/vmlinuz', endpoints)).toBe('https://vendor.example/vmlinuz-amd64');
    expect(resolveSource('/assets/talos-v1.13.8-x86_64/initrd', endpoints)).toBe('https://vendor.example/initramfs-amd64.xz');
  });

  it('never returns a source for iso_extraction (fallback to origin+path)', () => {
    expect(resolveSource('/releases/download/oracle-8-x86_64/vmlinuz', endpoints)).toBeNull();
  });

  it('returns null when the file is not in `files` or the path matches no endpoint', () => {
    expect(resolveSource('/assets/talos-v1.13.8-x86_64/unknown', endpoints)).toBeNull();
    expect(resolveSource('/assets/does-not-exist/vmlinuz', endpoints)).toBeNull();
  });

  it('tolerates a trailing slash on the requested path', () => {
    expect(resolveSource('/assets/talos-v1.13.8-x86_64/initrd/', endpoints)).toBe('https://vendor.example/initramfs-amd64.xz');
  });

  it('accepts the full { endpoints: {...} } document', () => {
    expect(resolveSource('/assets/talos-v1.13.8-x86_64/vmlinuz', { endpoints })).toBe('https://vendor.example/vmlinuz-amd64');
  });

  it('returns null for empty/undefined inputs', () => {
    expect(resolveSource('/assets/x/vmlinuz', null)).toBeNull();
    expect(resolveSource(undefined, endpoints)).toBeNull();
  });
});
