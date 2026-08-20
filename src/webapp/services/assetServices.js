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
    // The endpoints.yml path is a URL path relative to the origin. The local
    // mirror serves assets under /assets/download/... on the origin, but the
    // container stores them under /assets/download/... (nginx serves /assets at
    // its root), so drop the leading "assets/" namespace when mapping to the
    // filesystem. GitHub paths (/releases/download/...) have no such prefix.
    const fsRel = safePath.replace(/^assets\//, '');
    const dlpath = path.join(ASSETS_ROOT, path.dirname(fsRel));

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
