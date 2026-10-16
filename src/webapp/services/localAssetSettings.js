'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const blocked = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');
blocked.addAddress('::1', 'ipv6');
function invalid() { return Object.assign(new Error('Use a node-reachable, credential-free HTTPS Asset URL origin (root only); localhost and special IP addresses are not allowed.'), { code: 'PUBLIC_URL_INVALID' }); }
function validateOrigin(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value) || /[\s\\?#]/.test(value)) throw invalid();
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const dns = host.toLowerCase().replace(/\.$/, '');
    const family = net.isIP(host);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || dns === 'localhost' || dns.endsWith('.localhost')
      || (family === 6 && host.startsWith('::ffff:'))
      || (family && blocked.check(host, family === 4 ? 'ipv4' : 'ipv6'))
      || (!family && (dns.length > 253 || !dns.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))) throw invalid();
    // Reject paths normalized away by URL (e.g. /a/..), including empty userinfo.
    if (!/^https:\/\/[^/@]+\/?$/i.test(value)) throw invalid();
    return url.origin + '/';
  } catch { throw invalid(); }
}
function createSettings({ configRoot = process.env.UPONLAN_CONFIG || '/config' } = {}) {
  const root = path.resolve(configRoot);
  const file = path.join(root, 'local-assets.json');
  function parents(create = false) {
    let current = path.parse(root).root;
    for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    }
  }
  function checkFile() {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw invalid();
      return true;
    } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  }
  function parse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'assetUrl') throw invalid();
    return { assetUrl: validateOrigin(value.assetUrl) };
  }
  function get() {
    try {
      parents();
      if (!checkFile()) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw invalid();
        const buffer = Buffer.alloc(4097);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length > 4096) throw invalid();
        return parse(JSON.parse(buffer.subarray(0, length).toString('utf8'))).assetUrl;
      } finally { fs.closeSync(fd); }
    } catch (err) { if (err.code === 'ENOENT') return null; throw invalid(); }
  }
  function save(value) {
    const setting = parse(value);
    const temp = path.join(root, `.local-assets.${crypto.randomUUID()}.tmp`);
    try {
      parents(true); checkFile();
      fs.writeFileSync(temp, JSON.stringify(setting) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      return setting;
    } catch { throw invalid(); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  function resolve(options = {}) {
    function overrideOrigin(value) {
      try { return { url: validateOrigin(value), source: 'OKD override' }; }
      catch { const err = invalid(); err.message = 'Invalid OKD_PUBLIC_BASE_URL override. ' + err.message; throw err; }
    }
    if (Object.hasOwn(options, 'publicBaseUrl')) return overrideOrigin(options.publicBaseUrl);
    const override = process.env.OKD_PUBLIC_BASE_URL;
    if (override) return overrideOrigin(override);
    const url = get();
    if (url) return { url, source: 'Shared Local Assets' };
    throw Object.assign(new Error('Set Asset server URL in OKD → Operations → Asset server, or configure OKD_PUBLIC_BASE_URL. No node-reachable HTTPS asset origin is configured.'), { code: 'PUBLIC_URL_INVALID' });
  }
  return { get, save, resolve };
}
module.exports = { createSettings, validateOrigin, ...createSettings() };
