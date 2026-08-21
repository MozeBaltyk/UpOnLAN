'use strict';
const {
  getWebLog,
  getTftpLog,
  getNginxAccessLog,
  getNginxErrorLog,
  getRomBuildLog,
} = require('../services/logServices');
const { logWithTimestamp } = require('../services/utilServices');

module.exports = function registerLogHandlers(socket) {
  // Client-side toasts are recorded here too, so a popup is debuggable in the
  // webapp log rather than only visible for a few seconds on screen.
  socket.on('logmessage', (msg) => {
    logWithTimestamp(`[client] ${String(msg).slice(0, 2000)}`);
  });

  // Webapp logs
  socket.on('getweblog', () => {
    const log = getWebLog();
    socket.emit('renderweblog', log);
  });

  // TFTP logs
  socket.on('gettftplog', () => {
    const log = getTftpLog();
    socket.emit('rendertftplog', log);
  });

  // Nginx access logs
  socket.on('getnginxaccesslog', () => {
    const log = getNginxAccessLog();
    socket.emit('rendernginxaccesslog', log);
  });

  // Nginx error logs
  socket.on('getnginxerrorlog', () => {
    const log = getNginxErrorLog();
    socket.emit('rendernginxerrorlog', log);
  });

  // ROM / boot-media build log (most recent)
  socket.on('getrombuildlog', () => {
    const log = getRomBuildLog();
    socket.emit('renderrombuildlog', log);
  });
};