// ../services/metricsServices.js
const axios = require('axios');
const fs = require('fs');
const { getLocalNginx } = require('./utilServices');

// Nginx Metrics Collection
let previous = null;
let latestNginxMetrics = {
  accepts: 0,
  handled: 0,
  requests: 0,
  active: 0,
  timestamp: Date.now(),
};

async function collectNginxMetrics() {
  try {
    const nginxurl = getLocalNginx();
    const { data } = await axios.get(nginxurl + '/status');
    const lines = data.trim().split('\n');
    const active = parseInt(lines[0].split(':')[1].trim(), 10);
    const [accepts, handled, requests] = lines[2].trim().split(/\s+/).map(Number);
    const now = Date.now();

    if (previous) {
      const deltaMetrics = {
        accepts: Math.max(0, accepts - previous.accepts),
        handled: Math.max(0, handled - previous.handled),
        requests: Math.max(0, requests - previous.requests),
        active,
        timestamp: now,
      };

      latestNginxMetrics = deltaMetrics;
    }

    previous = { accepts, handled, requests, timestamp: now };
  } catch (err) {
    console.error('Error collecting NGINX metrics:', err.message);
  }
}

function getNginxMetrics() {
  return latestNginxMetrics;
}

// --- TFTP METRICS ---
const LOG_PATH = '/logs/tftp/tftpd.log';
let lastSize = 0;
let latestTftpMetrics = { requests: 0, timestamp: Date.now() };

function parseTftpRequestsFromLog(logData) {
  const lines = logData.split('\n');
  return lines.filter(line => line.includes('RRQ') || line.includes('WRQ')).length;
}

function collectTftpMetrics() {
  try {
    const stats = fs.statSync(LOG_PATH);
    const currentSize = stats.size;

    if (currentSize <= lastSize) return; // nothing new or rotated

    const stream = fs.createReadStream(LOG_PATH, {
      encoding: 'utf8',
      start: lastSize,
      end: currentSize - 1,
    });

    let data = '';
    stream.on('data', chunk => data += chunk);
    stream.on('end', () => {
      const newRequests = parseTftpRequestsFromLog(data);
      latestTftpMetrics = {
        requests: newRequests,
        timestamp: Date.now(),
      };
      lastSize = currentSize;
    });
  } catch (err) {
    console.error('Failed to collect TFTP metrics:', err.message);
  }
}

function getTftpMetrics() {
  return latestTftpMetrics;
}

module.exports = {
  collectNginxMetrics,
  getNginxMetrics,
  collectTftpMetrics,
  getTftpMetrics,
};

// Start periodic polling 10s
const POLL_INTERVAL = 10000;
setInterval(collectNginxMetrics, POLL_INTERVAL);
setInterval(collectTftpMetrics, POLL_INTERVAL);