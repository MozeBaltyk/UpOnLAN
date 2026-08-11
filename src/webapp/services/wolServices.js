'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { exec } = require('child_process');

const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
const WOL_CONFIG = path.join(CONFIG_ROOT, 'wol.yml');

function isValidMac(mac) {
  return /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac);
}

function readWolConfig() {
  const content = fs.readFileSync(WOL_CONFIG, 'utf8');
  return yaml.load(content) || { wakeonlan: [] };
}

function writeWolConfig(data) {
  fs.writeFileSync(WOL_CONFIG, yaml.dump(data));
}

function getWolEntries() {
  return readWolConfig();
}

function addWolEntry(newEntry) {
  const data = readWolConfig();
  if (!isValidMac(newEntry.default_mac)) throw new Error('Invalid MAC address');
  if (data.wakeonlan.some(e => e.default_mac.toLowerCase() === newEntry.default_mac.toLowerCase())) {
    throw new Error('MAC address already exists');
  }
  data.wakeonlan.push(newEntry);
  writeWolConfig(data);
  return data;
}

function deleteWolEntry(mac) {
  const data = readWolConfig();
  const before = data.wakeonlan.length;
  data.wakeonlan = data.wakeonlan.filter(e => e.default_mac.toLowerCase() !== mac.toLowerCase());
  if (data.wakeonlan.length === before) throw new Error('Entry not found');
  writeWolConfig(data);
  return data;
}

function wakeHost(mac, callback) {
  // Sanitize then validate before ever touching the shell (prevents command injection)
  const sanitized = String(mac || '').replace(/[^0-9A-Fa-f:-]/g, '');
  if (!isValidMac(sanitized)) {
    callback(new Error('Invalid MAC address'));
    return;
  }
  exec(`awake ${sanitized}`, (err, stdout, stderr) => {
    callback(err, stdout, stderr);
  });
}

module.exports = {
  getWolEntries,
  addWolEntry,
  deleteWolEntry,
  wakeHost
};