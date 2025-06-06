// ./services/assetServices.js - This module handles downloading remote assets and managing local assets.
const fs = require('fs');
const path = require('path');
const { getAssetOrigin, downloader } = require('./utilServices');

async function dlremote(dlfiles, callback, io, socket) {
  let asset_url;
  try {
    asset_url = getAssetOrigin();
  } catch (err) {
    console.error(err.message);
    callback(err, null);
    return;
  }
  const dlarray = [];
  for (let dlfile of dlfiles) {
    const safePath = dlfile.replace(/^\/+/, '/'); // prevent double slashes
    const dlpath = path.join('/assets', path.dirname(safePath));

    fs.mkdirSync(dlpath, { recursive: true });

    const full_url = asset_url + safePath;
    dlarray.push({ 'url': full_url, 'path': dlpath });
  }
  await downloader(dlarray, io, socket);
  callback(null, 'done');
}

module.exports = {
  dlremote,
};