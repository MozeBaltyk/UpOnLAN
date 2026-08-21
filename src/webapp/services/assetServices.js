// ./services/assetServices.js - This module handles downloading remote assets and managing local assets.
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { getAssetOrigin, downloader } = require('./utilServices');

const ASSETS_ROOT = process.env.UPONLAN_ASSETS || '/assets';
const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';

// Read the asset catalog (endpoints.yml) from the config volume. Returns an
// empty object on any error so dlremote can still fall back to origin+path.
function loadEndpoints() {
  try {
    const raw = fs.readFileSync(path.join(CONFIG_ROOT, 'endpoints.yml'), 'utf8');
    return yaml.load(raw) || {};
  } catch (err) {
    return {};
  }
}

// Resolve a requested asset path (e.g. /assets/<key>/<file> or
// /releases/download/<key>/<file>) to its on-demand vendor source URL.
//
// `path` is matched against each endpoint's `path` prefix; the remainder is
// looked up in `files` and its index used to fetch `sources[index]`. Only
// direct_file endpoints carry vendor `sources` (iso_extraction files come from
// a single ISO extracted at build time, served via origin+path), so those
// resolve to null and the caller falls back to `${origin}${path}`.
function resolveSource(path, endpoints) {
  const map = endpoints && endpoints.endpoints ? endpoints.endpoints : endpoints;
  if (!map) return null;
  const req = String(path || '').replace(/\/+$/, '');
  for (const ep of Object.values(map)) {
    if (!ep || typeof ep.path !== 'string') continue;
    if (req.startsWith(ep.path)) {
      const file = req.slice(ep.path.length);
      const idx = Array.isArray(ep.files) ? ep.files.indexOf(file) : -1;
      if (idx !== -1 && ep.build_type === 'direct_file' && Array.isArray(ep.sources) && ep.sources[idx]) {
        return ep.sources[idx];
      }
    }
  }
  return null;
}

async function dlremote(dlfiles, callback, socket) {
  let asset_url;
  try {
    asset_url = getAssetOrigin();
  } catch (err) {
    console.error(err.message);
    callback(err, null);
    return;
  }
  const endpoints = loadEndpoints();
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

    // direct_file assets are pulled from their vendor URL; everything else
    // (iso_extraction / GitHub bundles) comes from the configured origin.
    const source = resolveSource('/' + safePath, endpoints);
    const full_url = source || `${origin}/${safePath}`;
    // Pin the saved filename: a vendor URL's basename may differ from the
    // endpoint's file name (e.g. initramfs-amd64.xz -> initrd).
    const item = { 'url': full_url, 'path': dlpath };
    if (source) item.fileName = path.basename(fsRel);
    dlarray.push(item);
  }
  await downloader(dlarray, socket);
  callback(null, 'done');
}

module.exports = {
  dlremote,
  resolveSource,
};
