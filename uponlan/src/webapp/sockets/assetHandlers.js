const fs = require('fs');
const yaml = require('js-yaml');
const readdirp = require('readdirp');
const fetch = require('node-fetch'); // if not globally available
const { getMenuVersion, fetchDevReleases, fetchNetbootReleases, } = require('../services/menuServices');
const { dlremote } = require('../services/assetServices');

module.exports = function registerAssetHandlers(socket, io) {
  // Download remote files
  socket.on('dlremote', (files) => {
    dlremote(files, (err, result) => {
      if (err) return socket.emit('error', err.message);
      socket.emit('dlremotedone', result);
    }, io, socket);
  });

  // Send local endpoints and asset files to client
  socket.on('getlocal', async function () {
    try {
      const endpointsFile = fs.readFileSync('/config/endpoints.yml', 'utf8');
      const endpoints = yaml.load(endpointsFile);
      const localfiles = await readdirp.promise('/assets/.');
      const assets = localfiles.map(f => '/' + f.path);
      const menuversion = getMenuVersion();
      io.sockets.in(socket.id).emit('renderlocal', endpoints, assets, menuversion);
    } catch (error) {
      console.error('getlocal error:', error.stack || error);
      socket.emit('error', 'Failed to load local assets: ' + error.message);
    }
  });

  // Delete specified local assets
  socket.on('deletelocal', function (dlfiles) {
    try {
      for (const file of dlfiles) {
        const fullPath = path.join('/assets', file);
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

  // Fetch latest releases and commits from netboot.xyz
  socket.on('nbgetbrowser', async function () {
    try {
      const { releases, commits } = await fetchNetbootReleases();
      io.to(socket.id).emit('nbrenderbrowser', releases, commits);
    } catch (error) {
      console.error('nbgetbrowser error:', error.stack || error);
      socket.emit('error', 'Failed to fetch Netboot.xyz browser data: ' + error.message);
    }
  });

  // Fetch latest releases from Endpoint URL
  socket.on('devgetbrowser', async function () {
    try {
      const releases = await fetchDevReleases();
      io.sockets.in(socket.id).emit('devrenderbrowser', releases);
    } catch (error) {
      console.error('devgetbrowser error:', error.stack || error);
      socket.emit('error', 'Failed to fetch UpOnLAN.xyz browser data: ' + error.message);
    }
  });
};