// ./services/assetServices.js - This module handles downloading remote assets and managing local assets.
'use strict';
const fs = require('fs');
const path = require('path');
const { getAssetOrigin, downloader } = require('./utilServices');

const ASSETS_ROOT = process.env.UPONLAN_ASSETS || '/assets';

async function dlremote(dlfiles, callback, socket) {
  let asset_url;
  try {
    asset_url = getAssetOrigin();
  } catch (err) {
    console.error(err.message);
    callback(err, null);
    return;
  }
  const dlarray = [];
  const origin = asset_url.replace(/\/+$/, '');
  for (let dlfile of dlfiles) {
    const safePath = dlfile.replace(/^\/+/, '');
    const dlpath = path.join(ASSETS_ROOT, path.dirname(safePath));

    fs.mkdirSync(dlpath, { recursive: true });

    const full_url = `${origin}/${safePath}`;
    dlarray.push({ 'url': full_url, 'path': dlpath });
  }
  await downloader(dlarray, socket);
  callback(null, 'done');
}

module.exports = {
  dlremote,
};
