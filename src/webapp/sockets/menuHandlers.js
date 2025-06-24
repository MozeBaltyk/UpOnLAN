// ./sockets/menuHandlers.js
const fs = require('fs');
const { 
  getLocalNginx, 
  getMenuVersion, 
  logWithTimestamp, 
  errorWithTimestamp, 
} = require('../services/utilServices');
const {
  upgrademenu,
  upgrademenunetboot,
  emptymenu,
  getipxefiles,
  getromfiles,
  getindexfiles,
  createipxe,
  saveconfig,
  revertconfig,
  editgetfile,
  fetchDevReleases, 
  fetchNetbootReleases,
  runBuildPlaybook,
} = require('../services/menuServices');

// This module handles menu-related socket events for the UponLAN web application.
module.exports = function registerMenuHandlers(socket, io) {

  socket.on('emptymenu', () => emptymenu(socket));

  socket.on('createipxe', (filename) => createipxe(filename, socket));

  socket.on('saveconfig', (filename, text) => saveconfig(filename, text, socket));
  
  socket.on('revertconfig', (filename) => revertconfig(filename, socket));

  socket.on('editgetfile', (filename, islocal) => editgetfile(filename, islocal, socket));

  socket.on('buildsubmit', async (options) => {
    try {
      const output = await runBuildPlaybook(options, socket);
      socket.emit('buildMenuResult', { success: true, message: output });
    } catch (err) {
      socket.emit('buildMenuResult', { success: false, message: 'Build failed: ' + err.message });
    }
  });

  socket.on('upgrademenu', (version) => { upgrademenu(version, (err, result) => {
      if (err) { 
        return socket.emit('error', err.message); 
      }
      logWithTimestamp('Menu upgrade complete:', result);
      socket.emit('upgrademenu_complete');
    }, io, socket);
  });

  socket.on('upgrademenunetboot', (version) => { upgrademenunetboot(version, (err, result) => {
      if (err) { 
        return socket.emit('error', err.message); 
      }
      logWithTimestamp('Menu Netboot upgrade complete:', result);
      socket.emit('upgrademenu_complete');
    }, io, socket);
  });

  socket.on('getconfig', async () => {
    try {
      const { local_files, remote_files } = await getipxefiles();
      const { list_rom_files } = await getromfiles();
      const { list_index_files } = await getindexfiles();
      const local_nginx_url = getLocalNginx();
      const menu_version = getMenuVersion();

      socket.emit('renderconfig', remote_files, local_files, list_rom_files, list_index_files, local_nginx_url, menu_version);
    } catch (err) {
      errorWithTimestamp('getconfig failed:', err);
      socket.emit('error', 'Failed to get config: ' + err.message);
    }
  });

  // Fetch latest releases and commits from netboot.xyz
  socket.on('nbgetbrowser', async function () {
    try {
      const { releases, commits } = await fetchNetbootReleases();
      io.to(socket.id).emit('nbrenderbrowser', releases, commits);
    } catch (error) {
      errorWithTimestamp('nbgetbrowser error:', error);
      socket.emit('error', 'Failed to fetch Netboot.xyz browser data: ' + error.message);
    }
  });

  // Fetch latest releases from Endpoint URL
  socket.on('devgetbrowser', async function () {
    try {
      const releases = await fetchDevReleases();
      io.sockets.in(socket.id).emit('devrenderbrowser', releases);
    } catch (error) {
      errorWithTimestamp('devgetbrowser error:', error);
      socket.emit('error', 'Failed to fetch Endpoint browser data: ' + error.message);
    }
  });

};