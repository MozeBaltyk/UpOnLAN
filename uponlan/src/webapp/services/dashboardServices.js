const fs = require('fs');
const exec = require('child_process').exec;
const fetch = require('node-fetch');
const si = require('systeminformation');
const { version } = require('../package.json');
const { getMenuVersion, getMenuOrigin } = require('./menuServices');

function execCommand(cmd) {
  return new Promise(resolve => {
    exec(cmd, (err, stdout, stderr) => {
      resolve((stdout || stderr || '').trim());
    });
  });
}

async function getDashboardInfo() {
  const dashinfo = {
    webversion: version,
    menuversion: getMenuVersion(),
    menuorigin: getMenuOrigin()
  };

  try {
    const res = await fetch('https://api.github.com/repos/mozebaltyk/uponlan/releases/latest', {
      headers: { 'user-agent': 'node.js' }
    });
    const body = await res.json();
    dashinfo.remotemenuversion = body.tag_name;
  } catch (e) {
    console.warn("Failed to fetch remote version", e);
  }

  dashinfo.cpu = await si.cpu();
  dashinfo.mem = await si.mem();
  const load = await si.currentLoad();
  dashinfo.CPUpercent = load.currentload_user;
  dashinfo.tftpversion = await execCommand('/usr/sbin/dnsmasq --version | head -n1 | cut -d " " -f1-3');
  dashinfo.nginxversion = await execCommand('/usr/sbin/nginx -v');
  dashinfo.wolversion = await execCommand('/usr/bin/awake --version');

  return dashinfo;
}

module.exports = { getDashboardInfo };