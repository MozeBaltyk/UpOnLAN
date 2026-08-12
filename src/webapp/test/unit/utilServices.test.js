// Unit tests: URL derivation (menu.yml -> api/raw/latest), asset origin
// special-casing, and nginx listen-directive parsing. Pure string/fs logic
// against a real fixture config; no server, no mocks.
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureRoot } from '../helpers/fixtures.js';

let menuFile;
let nginxFile;

beforeAll(() => {
  const root = createFixtureRoot();
  menuFile = path.join(root, 'config', 'menu.yml');
  nginxFile = path.join(root, 'config', 'nginx', 'site-confs', 'default');
  process.env.UPONLAN_CONFIG = path.join(root, 'config');
});

async function loadServices() {
  vi.resetModules();
  return (await import('../../services/utilServices.js')).default;
}

describe('utilServices.getEndpointUrls', () => {
  it('derives api/raw/latest URLs from a github origin', async () => {
    fs.writeFileSync(menuFile, 'menu:\n  origin: https://github.com/mozebaltyk/uponlan\n');
    const svc = await loadServices();
    const { endpoint_url, api_url, raw_url, latest_url } = svc.getEndpointUrls();
    expect(endpoint_url).toBe('https://github.com/mozebaltyk/uponlan');
    expect(api_url).toBe('https://api.github.com/repos/mozebaltyk/uponlan/');
    expect(raw_url).toBe('https://raw.githubusercontent.com/mozebaltyk/uponlan/main/');
    expect(latest_url).toBe('https://api.github.com/repos/mozebaltyk/uponlan/releases/latest');
  });

  it('falls back to the default endpoint when origin is missing/invalid', async () => {
    fs.writeFileSync(menuFile, 'menu: {}\n');
    const svc = await loadServices();
    const { endpoint_url } = svc.getEndpointUrls();
    expect(endpoint_url).toBe('https://github.com/mozebaltyk/uponlan');
  });

  it('normalizes trailing slashes on the origin', async () => {
    fs.writeFileSync(menuFile, 'menu:\n  origin: https://github.com/mozebaltyk/uponlan///\n');
    const svc = await loadServices();
    const { endpoint_url } = svc.getEndpointUrls();
    expect(endpoint_url).toBe('https://github.com/mozebaltyk/uponlan');
  });
});

describe('utilServices.getAssetOrigin', () => {
  it('special-cases the netboot.xyz repo', async () => {
    fs.writeFileSync(menuFile, 'menu:\n  origin: https://github.com/netbootxyz/netboot.xyz\n');
    const svc = await loadServices();
    expect(svc.getAssetOrigin()).toBe('https://github.com/netbootxyz');
  });

  it('returns the plain origin otherwise', async () => {
    fs.writeFileSync(menuFile, 'menu:\n  origin: https://example.com/foo\n');
    const svc = await loadServices();
    expect(svc.getAssetOrigin()).toBe('https://example.com/foo');
  });
});

describe('utilServices.isValidUrl', () => {
  it('accepts well-formed URLs and rejects garbage', async () => {
    const svc = await loadServices();
    expect(svc.isValidUrl('https://example.com/path')).toBe(true);
    expect(svc.isValidUrl('ftp://host')).toBe(true);
    expect(svc.isValidUrl('not a url')).toBe(false);
    expect(svc.isValidUrl('')).toBe(false);
  });
});

describe('utilServices.getLocalNginx', () => {
  it('parses an https listen directive', async () => {
    fs.writeFileSync(nginxFile, 'server {\n  listen 443 ssl;\n  server_name _;\n}\n');
    const svc = await loadServices();
    expect(svc.getLocalNginx()).toBe('https://localhost:443');
  });

  it('parses a plain http listen directive', async () => {
    fs.writeFileSync(nginxFile, 'server {\n  listen 8080;\n}\n');
    const svc = await loadServices();
    expect(svc.getLocalNginx()).toBe('http://localhost:8080');
  });

  it('falls back to http://localhost when the config is unreadable', async () => {
    fs.rmSync(nginxFile);
    const svc = await loadServices();
    expect(svc.getLocalNginx()).toBe('http://localhost');
  });
});
