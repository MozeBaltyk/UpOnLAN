'use strict';
const wolService = require('../services/wolServices');

module.exports = function registerWolHandlers(socket) {
  socket.on('getwol', async () => {
    try {
      const data = await wolService.getWolEntriesWithStatus();
      socket.emit('renderwol', data);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // add/update/delete re-emit with live status so the IP badge reflects the
  // new entry immediately (a raw-config emit would render every host "unknown"
  // until the next getwol).
  socket.on('addwol', async (newEntry) => {
    try {
      wolService.addWolEntry(newEntry);
      socket.emit('renderwol', await wolService.getWolEntriesWithStatus());
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('updatewol', async (payload) => {
    try {
      wolService.updateWolEntry(payload.default_mac, payload);
      socket.emit('renderwol', await wolService.getWolEntriesWithStatus());
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('deletewol', async (mac) => {
    try {
      wolService.deleteWolEntry(mac);
      socket.emit('renderwol', await wolService.getWolEntriesWithStatus());
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
