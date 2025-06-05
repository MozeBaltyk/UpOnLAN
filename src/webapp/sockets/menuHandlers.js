const fs = require('fs');
const {
  upgrademenu,
  upgrademenunetboot,
  emptymenu,
  createipxe,
  saveconfig,
  revertconfig,
  editgetfile,
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
    }, io, socket);
  });

  socket.on('upgrademenunetboot', (version) => {
    upgrademenunetboot(version, (err, result) => {
      if (err) {
        return socket.emit('error', err.message);
      }
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

};