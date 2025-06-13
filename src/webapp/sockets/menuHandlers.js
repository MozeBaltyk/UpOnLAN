// ./sockets/menuHandlers.js
const fs = require('fs');
const {
  upgrademenu,
  upgrademenunetboot,
  emptymenu,
  getipxefiles,
  getromfiles,
  createipxe,
  saveconfig,
  revertconfig,
  editgetfile,
  fetchDevReleases, 
  fetchNetbootReleases,
} = require('../services/menuServices');

// This module handles menu-related socket events for the UponLAN web application.
module.exports = function registerMenuHandlers(socket, io) {

  socket.on('emptymenu', () => emptymenu(socket, io));

  socket.on('createipxe', (filename) => createipxe(filename, socket, io));

  socket.on('saveconfig', (filename, text) => saveconfig(filename, text, socket, io));
  
  socket.on('revertconfig', (filename) => revertconfig(filename, socket, io));

  socket.on('editgetfile', (filename, islocal) => editgetfile(filename, islocal, socket));

  socket.on('upgrademenu', (version) => {
    upgrademenu(version, (err, result) => {
      if (err) { 
        return socket.emit('error', err.message); 
      }
      console.log('Menu upgrade complete:', result);
      socket.emit('upgrademenu_complete');
    }, io, socket);
  });

  socket.on('upgrademenunetboot', (version) => {
    upgrademenunetboot(version, (err, result) => {
      if (err) { 
        return socket.emit('error', err.message); 
      }
      console.log('Menu Netboot upgrade complete:', result);
      socket.emit('upgrademenu_complete');
    }, io, socket);
  });

  socket.on('getconfig', async () => {
    try {
      const { local_files, remote_files } = await getipxefiles();
      const { list_rom_files} = await getromfiles();
      socket.emit('renderconfig', remote_files, local_files, list_rom_files);
    } catch (err) {
      console.error('getconfig failed:', err);
      socket.emit('error', 'Failed to get config: ' + err.message);
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
      socket.emit('error', 'Failed to fetch Endpoint browser data: ' + error.message);
    }
  });

};