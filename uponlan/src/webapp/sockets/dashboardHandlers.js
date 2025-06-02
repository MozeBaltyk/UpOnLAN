const { getDashboardInfo } = require('../services/dashboardServices');

module.exports = function registerDashboardHandlers(socket) {
  socket.on('getdash', async () => {
    try {
      const dashinfo = await getDashboardInfo();
      socket.emit('renderdash', dashinfo);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });
};