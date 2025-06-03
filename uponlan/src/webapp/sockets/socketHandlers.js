// ../sockets/socketHandlers.js
const registerDashboardHandlers = require('./dashboardHandlers');
const registerWolHandlers = require('./wolHandlers');
const registerMenuHandlers = require('./menuHandlers');
const registerAssetHandlers = require('./assetHandlers');
const registerLogHandlers = require('./logHandlers');
const registerMetricHandlers = require('./metricHandlers');

module.exports = function(io) {
  io.on('connection', (socket) => {
    const timestamp = new Date().toISOString(); // e.g., "2025-06-03T18:30:12.123Z"
    console.log(`[${timestamp}] socket_id: ${socket.id} connected`);
    socket.join(socket.id);

    // Register different sets of socket listeners
    registerDashboardHandlers(socket);
    registerMenuHandlers(socket, io);
    registerAssetHandlers(socket, io);
    registerLogHandlers(socket, io);
    registerMetricHandlers(socket, io);
    registerWolHandlers(socket);
  });
};