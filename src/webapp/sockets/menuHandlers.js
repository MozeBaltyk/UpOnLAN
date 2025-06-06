// ./sockets/menuHandlers.js
const fs = require('fs');
const {
  upgrademenu,
  upgrademenunetboot,
  emptymenu,
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
      if (err) { return socket.emit('error', err.message); }
      console.log('Menu upgrade complete:', result);
    }, io, socket);
  });

  socket.on('upgrademenunetboot', (version) => {
    upgrademenunetboot(version, (err, result) => {
      if (err) { return socket.emit('error', err.message); }
      console.log('Netboot menu upgrade complete:', result);
    }, io, socket);
  });

  socket.on('getconfig', () => {
    const local_files = fs.readdirSync('/config/menus/local', { withFileTypes: true })
      .filter(d => !d.isDirectory()).map(d => d.name);
    const remote_files = fs.readdirSync('/config/menus/remote', { withFileTypes: true })
      .filter(d => !d.isDirectory()).map(d => d.name);
    socket.emit('renderconfig', remote_files, local_files);
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