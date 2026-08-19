// Test fixture filesystem. Builds a realistic copy of the container's mounted
// volumes (/config, /assets, /docs, /logs) inside a temp dir so the real
// services read/write real files with zero mocking.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function write(dir, file, content) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildFixtureFilesystem(root, overrides = {}) {
  const files = {
    'config/endpoints.yml': `endpoints:\n  oracle-8-x86_64:\n    path: /releases/download/oracle-8-x86_64/\n    files:\n    - vmlinuz\n    - initrd\n    os: oracle\n    version: '8'\n    arch: x86_64\n`,
    'config/menu.yml': `menu:\n  origin: https://github.com/mozebaltyk/uponlan\n  version: 0.0.2\n`,
    'config/wol.yml': `wakeonlan:\n  - default_mac: "00:11:22:33:44:55"\n    name: Test Machine\n`,
    'config/nginx/site-confs/default': `server {\n  listen 443 ssl;\n  server_name _;\n}\n`,
    'config/menus/remote/boot.cfg': `#!ipxe\nset sigs_enabled true\n`,
    'config/menus/remote/example.ipxe': `#!ipxe\necho hello\n`,
    'config/menus/local/.keep': '',
    'config/menus/rom/.keep': '',
    'docs/index.md': `# Home\n\nWelcome to UpOnLAN.\n`,
    'docs/guides/advanced.md': `## Advanced\n\nDeep content.\n`,
    'logs/tftp/tftpd.log': `dnsmasq-tftp[40]: sent /config/menus/menu.ipxe to 10.0.0.1\ndnsmasq-tftp[40]: sent /config/menus/boot.cfg to 10.0.0.1\nunrelated line\n`,
    'logs/nginx/access.log': `127.0.0.1 - - [01/Jan/2026:00:00:00 +0000] "GET / HTTP/1.1" 200\n`,
    'logs/nginx/error.log': `[error] nothing to see here\n`,
    'logs/webapp/webapp.log': `[2026-01-01T00:00:00.000Z] server started\n`,
    'assets/sample.txt': 'asset content\n',
    'assets/ipxe/test-rom.ipxe': '#!ipxe\n',
  };
  Object.assign(files, overrides);
  for (const [rel, content] of Object.entries(files)) {
    write(root, rel, content);
  }
  return root;
}

function createFixtureRoot(overrides) {
  return buildFixtureFilesystem(fs.mkdtempSync(path.join(os.tmpdir(), 'uponlan-test-')), overrides);
}

module.exports = { createFixtureRoot };
