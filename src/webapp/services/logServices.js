const fs = require('fs');
const RootLogPath = "/logs";

function readLogFile(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    console.error(`Error reading log file at ${logPath}:`, e.message);
    return 'Log file not found or unreadable.';
  }
}

function getWebLog() {
  const logPath = RootLogPath + '/webapp/webapp.log';
  return readLogFile(logPath);
}

function getTftpLog() {
  const logPath = RootLogPath + '/tftp/tftpd.log';
  return readLogFile(logPath);
}

function getNginxAccessLog() {
  const accessLogPath = RootLogPath + '/nginx/access.log';
  return fs.existsSync(accessLogPath) ? readLogFile(accessLogPath) : 'access.log not found or unreadable.';
}

function getNginxErrorLog() {
  const errorLogPath = RootLogPath + '/nginx/error.log';
  return fs.existsSync(errorLogPath) ? readLogFile(errorLogPath) : 'error.log not found or unreadable.';
}

module.exports = {
  getWebLog,
  getTftpLog,
  getNginxAccessLog,
  getNginxErrorLog,
};