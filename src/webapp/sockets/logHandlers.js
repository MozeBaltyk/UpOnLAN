'use strict';
const {
  getWebLog,
  getTftpLog,
  getNginxAccessLog,
  getNginxErrorLog,
  getRomBuildLog,
} = require('../services/logServices');

module.exports = function registerLogHandlers(socket) {
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