// ../sockets/metricHandlers.js
'use strict';
const { getNginxMetrics, getTftpMetrics, } = require('../services/metricServices');

const METRICS_POLL_MS = 10000;
let broadcastTimer = null;

function buildMetricsPayload() {
  const nginx = getNginxMetrics();
  const tftp = getTftpMetrics();

  return {
    timestamp: Date.now(),
    nginx: nginx || { accepts: 0, handled: 0, requests: 0, active: 0, timestamp: Date.now() },
    tftp: tftp || { requests: 0, timestamp: Date.now() },
  };
}

module.exports = function registerMetricHandlers(io, socket) {
  // One shared broadcast timer for every connected socket instead of one
  // interval per socket (N tabs did N identical emits per tick). Skipped
  // under test so no stray timers keep the process alive.
  if (broadcastTimer === null && process.env.NODE_ENV !== 'test') {
    broadcastTimer = setInterval(() => io.emit('metrics:update', buildMetricsPayload()), METRICS_POLL_MS);
  }

  // Immediate snapshot so a freshly connected dashboard renders right away.
  socket.emit('metrics:update', buildMetricsPayload());
};