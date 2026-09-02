// ./services/dashboardServices.js
'use strict';
const fetch = require('node-fetch');
const si = require('systeminformation');
const { version } = require('../package.json');
const { getMenuVersion, getMenuOrigin, getEndpointUrls, execCommand, logWithTimestamp } = require('./utilServices');

async function getDashboardInfo() {
  const dashinfo = {
    webversion: version,
    menuversion: getMenuVersion(),
    menuorigin: getMenuOrigin()
  };

  try {
    const { latest_url } = getEndpointUrls();
    const res = await fetch(latest_url, {
      headers: { 'user-agent': 'node.js' }
    });
    const body = await res.json();
    dashinfo.remotemenuversion = body.tag_name;
    logWithTimestamp("Fetching latest release:", latest_url);
  } catch (e) {
    console.warn("Failed to fetch remote version", e);
  }

  dashinfo.cpu = await si.cpu();
  dashinfo.mem = await si.mem();
  // systeminformation returns camelCase fields (currentLoad/currentLoadUser);
  // currentLoad is the overall host CPU utilization, which is what the gauge shows.
  const load = await si.currentLoad();
  dashinfo.CPUpercent = load.currentLoad;
  dashinfo.tftpversion = await execCommand('/usr/sbin/dnsmasq --version | head -n1 | cut -d " " -f1-3');
  dashinfo.nginxversion = await execCommand('/usr/sbin/nginx -v');
  dashinfo.wolversion = await execCommand('/usr/bin/awake --version');

  return dashinfo;
}

module.exports = { getDashboardInfo };