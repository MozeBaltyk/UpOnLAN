const registerDashboardHandlers = require('./dashboardHandlers');
const registerWolHandlers = require('./wolHandlers');
const registerMenuHandlers = require('./menuHandlers');
const registerAssetHandlers = require('./assetHandlers');
const registerLogHandlers = require('./logHandlers');

module.exports = function(io) {
  io.on('connection', (socket) => {
    console.log(`${socket.id} connected at ${Date.now()}`);
    socket.join(socket.id);

    // Register different sets of socket listeners
    registerDashboardHandlers(socket);
    registerMenuHandlers(socket, io);
    registerAssetHandlers(socket, io);
    registerLogHandlers(socket, io);
    registerWolHandlers(socket);
  });
};