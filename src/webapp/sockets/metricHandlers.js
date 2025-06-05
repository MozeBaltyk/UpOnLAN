// ../sockets/metricHandlers.js
const { getNginxMetrics, getTftpMetrics, } = require('../services/metricServices');

module.exports = function registerMetricHandlers(socket) {
  const sendMetrics = () => {
    const nginx = getNginxMetrics();
    const tftp = getTftpMetrics();

    socket.emit('metrics:update', {
      timestamp: Date.now(),
      nginx: nginx || { accepts: 0, handled: 0, requests: 0, active: 0, timestamp: Date.now() },
      tftp: tftp || { requests: 0, timestamp: Date.now() },
    });
  };

  // Emit on a 10s interval
  const interval = setInterval(sendMetrics, 10000);

  // Optionally emit once immediately
  sendMetrics();

  // Cleanup
  socket.on('disconnect', () => {
    clearInterval(interval);
  });
};