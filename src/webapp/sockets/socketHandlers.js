// ../sockets/socketHandlers.js
'use strict';
const registerDashboardHandlers = require('./dashboardHandlers');
const registerWolHandlers = require('./wolHandlers');
const registerMenuHandlers = require('./menuHandlers');
const registerAssetHandlers = require('./assetHandlers');
const registerProvisioningHandlers = require('./provisioningHandlers');
const registerLogHandlers = require('./logHandlers');
const registerMetricHandlers = require('./metricHandlers');
const registerDocHandlers = require('./docHandlers');
const registerVmHandlers = require('./vmHandlers');
const registerOkdHandlers = require('./okdHandlers');

module.exports = function(io) {
  // Recover persisted OKD jobs at application startup; do not wait for a browser.
  // Keep the message fixed so filesystem paths or credential-bearing errors cannot leak.
  registerOkdHandlers.initialize().catch(() => {
    console.error('[ERROR] OKD job recovery failed; generation remains fail-closed.');
  });

  io.on('connection', (socket) => {
    const timestamp = new Date().toISOString(); // e.g., "2025-06-03T18:30:12.123Z"
    console.log(`[${timestamp}] socket_id: ${socket.id} connected`);
    socket.join(socket.id);

    // Register different sets of socket listeners
    registerDashboardHandlers(socket);
    registerMenuHandlers(socket, io);
    registerAssetHandlers(socket, io);
    registerProvisioningHandlers(socket);
    registerLogHandlers(socket, io);
    registerMetricHandlers(io, socket);
    registerWolHandlers(socket);
    registerDocHandlers(socket);
    registerVmHandlers(socket);
    registerOkdHandlers(socket);
  });
};
