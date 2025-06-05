const fs = require('fs');
const yaml = require('js-yaml');
const { exec } = require('child_process');

function isValidMac(mac) {
  return /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac);
}

function readWolConfig() {
  const content = fs.readFileSync('/config/wol.yml', 'utf8');
  return yaml.load(content) || { wakeonlan: [] };
}

function writeWolConfig(data) {
  fs.writeFileSync('/config/wol.yml', yaml.dump(data));
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
  exec(`awake ${mac}`, (err, stdout, stderr) => {
    callback(err, stdout, stderr);
  });
}

module.exports = {
  getWolEntries,
  addWolEntry,
  deleteWolEntry,
  wakeHost
};