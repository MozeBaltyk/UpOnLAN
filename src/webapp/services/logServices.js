'use strict';
const fs = require('fs');
const RootLogPath = process.env.UPONLAN_LOGS || "/logs";

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

// The ROM/media build runner (romBuildService.js) writes one timestamped log per
// build under /logs/rom. Show the most recent one, prefixed with its filename so
// a failure is debuggable without `podman exec`.
function getRomBuildLog() {
  const dir = RootLogPath + '/rom';
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('build_') && f.endsWith('.log'))
      .sort(); // ISO-timestamped names sort chronologically
  } catch (e) {
    return 'No ROM build logs yet.';
  }
  if (files.length === 0) return 'No ROM build logs yet.';
  const latest = files[files.length - 1];
  return `=== ${latest} ===\n${readLogFile(dir + '/' + latest)}`;
}

module.exports = {
  getWebLog,
  getTftpLog,
  getNginxAccessLog,
  getNginxErrorLog,
  getRomBuildLog,
};