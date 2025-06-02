const wolService = require('../services/wolServices');

module.exports = function registerWolHandlers(socket) {
  socket.on('getwol', () => {
    try {
      const data = wolService.getWolEntries();
      socket.emit('renderwol', data);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('addwol', (newEntry) => {
    try {
      const data = wolService.addWolEntry(newEntry);
      socket.emit('renderwol', data);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('deletewol', (mac) => {
    try {
      const data = wolService.deleteWolEntry(mac);
      socket.emit('renderwol', data);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('wakewol', (mac) => {
    wolService.wakeHost(mac, (err, stdout, stderr) => {
      if (err) {
        socket.emit('error', stderr || err.message);
      } else {
        socket.emit('info', `Wake command sent to ${mac}`);
      }
    });
  });
};
