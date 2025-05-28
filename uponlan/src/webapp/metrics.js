// nginx-metrics.js
const axios = require('axios');
const StatsD = require('hot-shots');
const statsd = new StatsD();
let latestNginxMetrics = {};

async function collectNginxMetrics() {
  try {
    const { data } = await axios.get('http://127.0.0.1/status');
    const lines = data.split('\n');
    const [, accepts, handled, requests] = lines[2].trim().split(/\s+/).map(Number);
    statsd.gauge('nginx.accepts', accepts);
    statsd.gauge('nginx.handled', handled);
    statsd.gauge('nginx.requests', requests);
    // Save for HTTP API
    latestNginxMetrics = { accepts, handled, requests };
  } catch (err) {
    console.error('Failed to collect NGINX metrics:', err.message);
  }
}
// poll every 30 seconds
setInterval(collectNginxMetrics, 30000);
// Initial collection
module.exports = { getLatestNginxMetrics: () => latestNginxMetrics };
