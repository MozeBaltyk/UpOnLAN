// ./sockets/assetHandlers.js
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const readdirp = require('readdirp');
const { getMenuOrigin, getLocalAssetUrl, getMenuVersion, getAssetOrigin } = require('../services/utilServices');
const { dlremote, genericAssetPath } = require('../services/assetServices');
const { listProvisioningAssets } = require('../services/provisioningServices');
const settings = require('../services/localAssetSettings');
const okdArtifacts = require('../services/okdArtifactServices');

const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
const ASSETS_ROOT = process.env.UPONLAN_ASSETS || '/assets';

module.exports = function registerAssetHandlers(socket, io) {
  socket.on('localAssets:get', (reply) => {
    if (typeof reply !== 'function') return;
    try {
      reply({ ok: true, data: { assetUrl: settings.get(), overrideActive: !!process.env.OKD_PUBLIC_BASE_URL } });
    }
    catch { reply({ ok: false, message: 'Unable to read stored Asset server URL. Save a valid HTTPS origin; check config storage permissions.' }); }
  });
  socket.on('localAssets:save', (request, reply) => {
    if (typeof reply !== 'function') return;
    try { reply({ ok: true, data: settings.save(request) }); }
    catch { reply({ ok: false, code: 'PUBLIC_URL_INVALID', message: 'Unable to save Asset server URL. Use a node-reachable, credential-free HTTPS root origin (not localhost); check config storage permissions.' }); }
  });
  // Download remote files
  socket.on('dlremote', (files) => {
    dlremote(files, (err, result) => {
      if (err) return socket.emit('error', err.message);
      socket.emit('dlremotedone', result);
    }, socket).catch((err) => {
      // downloader throws on 404/network errors; surface it instead of dying silently
      console.error('dlremote failed:', err.message);
      socket.emit('error', 'Download failed: ' + err.message);
    });
  });

  // Send local endpoints and asset files to client
  socket.on('getlocal', async function () {
    try {
      const endpointsFile = fs.readFileSync(path.join(CONFIG_ROOT, 'endpoints.yml'), 'utf8');
      const endpoints = yaml.load(endpointsFile);
      const localfiles = await readdirp.promise(ASSETS_ROOT + '/.');
      const assets = localfiles.filter((f) => genericAssetPath(f.path)).map(f => '/' + f.path);
      const provisioning = await listProvisioningAssets();
      const okd = await okdArtifacts.listAssets();
      const menuversion = getMenuVersion();
      const menuorigin = getMenuOrigin();
      const assetorigin = getAssetOrigin();
      let localSettings;
      try { localSettings = { assetUrl: settings.get(), error: '' }; }
      catch { localSettings = { assetUrl: null, error: 'Stored Asset URL is invalid. Save a valid HTTPS origin.' }; }
      const localNginx = localSettings.error ? '' : getLocalAssetUrl();
      io.sockets.in(socket.id).emit('renderlocal', endpoints, assets, menuversion, menuorigin, assetorigin, localNginx, provisioning, localSettings, okd);
    } catch (error) {
      console.error('getlocal error:', error.stack || error);
      socket.emit('error', 'Failed to load local assets: ' + error.message);
    }
  });

  // Delete specified local assets
  socket.on('deletelocal', function (dlfiles) {
    try {
      for (let  file of dlfiles) {
        const cleanPath = genericAssetPath(file);
        if (!cleanPath) continue;
        const fullPath = path.resolve(ASSETS_ROOT, cleanPath.replace(/^assets\//i, ''));

        // Prevent directory traversal
        if (!fullPath.startsWith(path.resolve(ASSETS_ROOT) + path.sep)) {
          console.warn('Blocked delete outside /assets:', fullPath);
          continue;
        }
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          console.log('Deleted', fullPath);
        }
        const part2Path = fullPath + '.part2';
        if (fs.existsSync(part2Path)) {
          fs.unlinkSync(part2Path);
          console.log('Deleted', part2Path);
        }
      }
      io.sockets.in(socket.id).emit('renderlocalhook');
    } catch (error) {
      console.error('deletelocal error:', error.stack || error);
      socket.emit('error', 'Failed to delete files: ' + error.message);
    }
  });

};
