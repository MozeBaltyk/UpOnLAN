// ../services/metricsServices.js
'use strict';
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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

// Pure: turns a raw stub_status sample into per-interval deltas relative to a
// previous sample. First sample and counter resets (nginx reload/restart) both
// report zero activity instead of a fake delta or a spike.
function computeNginxDeltas(previousSample, sample) {
  const { accepts, handled, requests, active, timestamp } = sample;

  if (!previousSample) {
    return { accepts: 0, handled: 0, requests: 0, active, timestamp };
  }

  const reset =
    accepts < previousSample.accepts ||
    handled < previousSample.handled ||
    requests < previousSample.requests;

  if (reset) {
    return { accepts: 0, handled: 0, requests: 0, active, timestamp };
  }

  return {
    accepts: accepts - previousSample.accepts,
    handled: handled - previousSample.handled,
    requests: requests - previousSample.requests,
    active,
    timestamp,
  };
}

async function collectNginxMetrics() {
  try {
    const nginxurl = getLocalNginx();
    const { data } = await axios.get(nginxurl + '/status');
    const lines = data.trim().split('\n');
    const active = parseInt(lines[0].split(':')[1].trim(), 10);
    const [accepts, handled, requests] = lines[2].trim().split(/\s+/).map(Number);

    // Reject a malformed stub_status response instead of letting NaN poison
    // the deltas. previous is left untouched, so the next good poll resumes.
    if (![active, accepts, handled, requests].every(Number.isFinite)) {
      console.error('NGINX /status returned unexpected data:', JSON.stringify(lines));
      return;
    }

    const now = Date.now();
    latestNginxMetrics = computeNginxDeltas(previous, { accepts, handled, requests, active, timestamp: now });
    previous = { accepts, handled, requests, timestamp: now };
  } catch (err) {
    console.error('Error collecting NGINX metrics:', err.message);
  }
}

function getNginxMetrics() {
  return latestNginxMetrics;
}

// --- TFTP METRICS ---
const LOG_PATH = path.join(process.env.UPONLAN_LOGS || '/logs', 'tftp/tftpd.log');
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
  parseTftpRequestsFromLog,
  computeNginxDeltas,
};

// Start periodic polling 10s (skipped under test so no stray timers)
const POLL_INTERVAL = 10000;
if (process.env.NODE_ENV !== 'test') {
  setInterval(collectNginxMetrics, POLL_INTERVAL);
  setInterval(collectTftpMetrics, POLL_INTERVAL);
}