'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { exec, execFile } = require('child_process');

const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
const WOL_CONFIG = path.join(CONFIG_ROOT, 'wol.yml');

function isValidMac(mac) {
  return /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac);
}

function isValidIp(ip) {
  if (typeof ip !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  return m.slice(1).every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255;
  });
}

function isValidWakeAt(dt) {
  if (typeof dt !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt) && !Number.isNaN(Date.parse(dt));
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
  if (newEntry.ip && !isValidIp(newEntry.ip)) throw new Error('Invalid IP address');
  if (newEntry.wake_at && !isValidWakeAt(newEntry.wake_at)) throw new Error('Invalid wake time');
  data.wakeonlan.push(newEntry);
  writeWolConfig(data);
  return data;
}

function updateWolEntry(mac, updates) {
  const data = readWolConfig();
  const entry = data.wakeonlan.find(e => e.default_mac.toLowerCase() === mac.toLowerCase());
  if (!entry) throw new Error('Entry not found');

  if (updates.hostname !== undefined) entry.hostname = updates.hostname;

  if ('ip' in updates) {
    if (updates.ip === null || updates.ip === '') {
      entry.ip = null;
    } else {
      if (!isValidIp(updates.ip)) throw new Error('Invalid IP address');
      entry.ip = updates.ip;
    }
  }

  if ('wake_at' in updates) {
    if (updates.wake_at === null || updates.wake_at === '') {
      entry.wake_at = null;
    } else {
      if (!isValidWakeAt(updates.wake_at)) throw new Error('Invalid wake time');
      entry.wake_at = updates.wake_at;
    }
  }

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

function pingHost(ip) {
  return new Promise((resolve) => {
    if (!isValidIp(ip)) return resolve(false);
    // -c 1: single probe; -W 1: one-second reply timeout (Linux ping)
    execFile('ping', ['-c', '1', '-W', '1', ip], (err) => {
      resolve(!err);
    });
  });
}

async function getWolEntriesWithStatus() {
  const data = readWolConfig();
  const withStatus = await Promise.all(data.wakeonlan.map(async (entry) => {
    let status = 'unknown';
    if (entry.ip) {
      status = (await pingHost(entry.ip)) ? 'online' : 'offline';
    }
    return { ...entry, status };
  }));
  return { wakeonlan: withStatus };
}

// Pure: which entries have a scheduled wake that is due at `now`.
function computeDueWakes(entries, now) {
  const nowMs = now.getTime();
  return entries.filter((e) => e.wake_at && Date.parse(e.wake_at) <= nowMs);
}

function checkScheduledWakes(now = new Date()) {
  const data = readWolConfig();
  const due = computeDueWakes(data.wakeonlan, now);
  let fired = 0;
  for (const entry of due) {
    wakeHost(entry.default_mac, () => {}); // fire-and-forget
    console.log(`Scheduled wake fired for ${entry.default_mac} (${entry.hostname || 'unnamed'})`);
    entry.wake_at = null; // one-shot: never re-fire
    fired++;
  }
  if (fired > 0) {
    writeWolConfig(data);
  }
  return fired;
}

module.exports = {
  getWolEntries,
  addWolEntry,
  updateWolEntry,
  deleteWolEntry,
  wakeHost,
  isValidMac,
  isValidIp,
  isValidWakeAt,
  pingHost,
  getWolEntriesWithStatus,
  computeDueWakes,
  checkScheduledWakes
};

// Background one-shot wake scheduler (skipped under test so no stray timers)
if (process.env.NODE_ENV !== 'test') {
  setInterval(checkScheduledWakes, 30000);
}
