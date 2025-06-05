const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { isBinaryFile } = require('isbinaryfile');
const { 
  downloader,
  deleteAllFilesInDir,
  deleteFiles,
  getEndpointUrls,
 } = require('./utilServices');

function getMenuVersion() {
  return fs.existsSync('/config/menuversion.txt') ? fs.readFileSync('/config/menuversion.txt', 'utf8') : 'none';
}

function getMenuOrigin() {
  return fs.existsSync('/config/menuorigin.txt') ? fs.readFileSync('/config/menuorigin.txt', 'utf8') : 'none';
}

function disablesigs() {
  const bootcfgr = '/config/menus/remote/boot.cfg';
  const bootcfgl = '/config/menus/local/boot.cfg';
  const bootcfgm = '/config/menus/boot.cfg';
  if (fs.existsSync(bootcfgr) && !fs.existsSync(bootcfgl)) {
    const data = fs.readFileSync(bootcfgr, 'utf8');
    const disable = data.replace(/set sigs_enabled true/g, 'set sigs_enabled false');
    fs.writeFileSync(bootcfgr, disable, 'utf8');
    fs.writeFileSync(bootcfgm, disable, 'utf8');
  }
}

function layermenu(callback, socket = null, filename = null) {
  const localDir = '/config/menus/local/';
  const remoteDir = '/config/menus/remote/';
  const targetDir = '/config/menus/';

  const local_files = fs.readdirSync(localDir, { withFileTypes: true })
    .filter(d => !d.isDirectory()).map(d => d.name);

  const remote_files = fs.readdirSync(remoteDir, { withFileTypes: true })
    .filter(d => !d.isDirectory()).map(d => d.name);

  for (const file of remote_files) {
    fs.copyFileSync(`${remoteDir}${file}`, `${targetDir}${file}`);
  }
  for (const file of local_files) {
    fs.copyFileSync(`${localDir}${file}`, `${targetDir}${file}`);
  }

  if (socket) {
    socket.emit('renderconfig', remote_files, local_files, filename || '', true);
  }

  if (typeof callback === 'function') {
    callback(null, 'done');
  }
}

async function fetchDevReleases() {
  const { api_url } = getEndpointUrls();
  const options = { headers: { 'user-agent': 'node.js' } };

  const releasesResponse = await fetch(api_url + 'releases', options);
  if (!releasesResponse.ok) {
    throw new Error(`GitHub API error fetching ${api_url}. Status: ${releasesResponse.status}`);
  }

  const releases = await releasesResponse.json();
  return releases;
}

async function fetchNetbootReleases() {
  const nb_api_url = 'https://api.github.com/repos/netbootxyz/netboot.xyz/';
  const options = { headers: { 'user-agent': 'node.js' } };

  const [releasesResponse, commitsResponse] = await Promise.all([
    fetch(nb_api_url + 'releases', options),
    fetch(nb_api_url + 'commits', options),
  ]);

  if (!releasesResponse.ok || !commitsResponse.ok) {
    throw new Error(`GitHub API error. Status: releases ${releasesResponse.status}, commits ${commitsResponse.status}`);
  }

  const releases = await releasesResponse.json();
  const commits = await commitsResponse.json();
  return {releases, commits};
}

// Upgrade menu function from given Endpoint
async function upgrademenu(version, callback, io, socket) {
  const { endpoint_url } = getEndpointUrls();
  const remote_folder = '/config/menus/remote/';
  const targetDir = '/config/menus/';
  
  deleteAllFilesInDir(targetDir);

  // Wipe current remote
  const remote_files = fs.readdirSync(remote_folder, { withFileTypes: true })
    .filter(dirent => !dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const file of remote_files) {
    fs.unlinkSync(path.join(remote_folder, file));
  }

  // Download menus.tar.gz  
  const downloads = [{
    url: `${endpoint_url}/releases/download/${version}/menus.tar.gz`,
    path: remote_folder,
  }];

  await downloader(downloads, io, socket);

  const tarFile = path.join(remote_folder, 'menus.tar.gz');
  const untarcmd = `tar xf ${tarFile} -C ${remote_folder}`;
  const origin = endpoint_url;

  exec(untarcmd, (err, stdout, stderr) => {
    if (err) {
      return callback(new Error(`untar failed: ${stderr}`));
    }

    try {
      fs.unlinkSync(tarFile);
      fs.writeFileSync('/config/menuversion.txt', version);
      fs.writeFileSync('/config/menuorigin.txt', origin);
    } catch (writeErr) {
      return callback(writeErr);
    }

    // Call layermenu and finish
    layermenu(() => {
      disablesigs();
      console.log('Menu updated');
    }, socket, null);
  });
}

// Upgrade menu function from Netboot.xyz repository
async function upgrademenunetboot(version, callback, io, socket) {
  const remote_folder = '/config/menus/remote/';
  const targetDir = '/config/menus/';
  
  deleteAllFilesInDir(targetDir);

  // Wipe current remote folder
  const remote_files = fs.readdirSync(remote_folder, { withFileTypes: true })
    .filter(dirent => !dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const file of remote_files) {
    fs.unlinkSync(path.join(remote_folder, file));
  }

  // ROM files to download
  const rom_files = [
    'netboot.xyz.kpxe',
    'netboot.xyz-undionly.kpxe',
    'netboot.xyz.efi',
    'netboot.xyz-snp.efi',
    'netboot.xyz-snponly.efi',
    'netboot.xyz-arm64.efi',
    'netboot.xyz-arm64-snp.efi',
    'netboot.xyz-arm64-snponly.efi',
  ];

  let downloads = [];
  let download_endpoint;
  let origin;

  const isCommitSha = version.length === 40;

  if (isCommitSha) {
    download_endpoint = `https://s3.amazonaws.com/dev.boot.netboot.xyz/${version}/ipxe/`;
    downloads.push({ url: `https://s3.amazonaws.com/dev.boot.netboot.xyz/${version}/menus.tar.gz`, path: remote_folder });
    origin = `https://s3.amazonaws.com/dev.boot.netboot.xyz/`;
  } else {
    download_endpoint = `https://github.com/netbootxyz/netboot.xyz/releases/download/${version}/`;
    downloads.push({ url: `${download_endpoint}menus.tar.gz`, path: remote_folder });
    origin = 'https://github.com/netbootxyz/netboot.xyz/';
  }

  // Add ROM files to download list
  for (const file of rom_files) {
    downloads.push({ url: download_endpoint + file, path: remote_folder });
  }

  // Add static endpoints config
  downloads.push({
    url: `https://raw.githubusercontent.com/netbootxyz/netboot.xyz/${version}/endpoints.yml`,
    path: '/config/',
  });

  await downloader(downloads, io, socket);

  const tarFile = path.join(remote_folder, 'menus.tar.gz');
  const untarcmd = `tar xf ${tarFile} -C ${remote_folder}`;

  const displayVersion = isCommitSha ? 'Development' : version;

  exec(untarcmd, (err, stdout, stderr) => {
    if (err) {
      return callback(new Error(`untar failed: ${stderr}`));
    }

    try {
      fs.unlinkSync(tarFile);
      fs.writeFileSync('/config/menuversion.txt', displayVersion);
      fs.writeFileSync('/config/menuorigin.txt', origin);
    } catch (writeErr) {
      return callback(writeErr);
    }

    // Call layermenu and finish
    layermenu(() => {
      disablesigs();
      console.log('Menu updated');
    }, socket, null);
  });
}

// Empty Menu
function emptymenu(socket, io) {
    try {
      // Delete all files in local and remote directories
      deleteAllFilesInDir('/config/menus/local');
      deleteAllFilesInDir('/config/menus/remote');
      deleteAllFilesInDir('/config/menus');
      deleteFiles('/config/menuversion.txt');
      deleteFiles('/config/menuorigin.txt');

      // Optionally, re-render the config for the client
      var local_files = fs.readdirSync('/config/menus/local',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      var remote_files = fs.readdirSync('/config/menus/remote',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      io.sockets.in(socket.id).emit('renderconfig', remote_files, local_files);
    } catch (err) {
      console.error('Failed to reset menu:', err);
      socket.emit('error', 'Failed to reset menu: ' + err.message);
    }
}

function isValidFilename(filename) {
  // Allow only alphanumeric, underscores, dashes and must end with .ipxe
  const validPattern = /^[a-zA-Z0-9_-]+\.(ipxe|cfg)$/;
  return validPattern.test(filename);
}

function createipxe(filename, socket, io) {
  const rootDir = '/config/menus/local/';
  const filePath = path.resolve(rootDir, filename);
  // Validate filename format
  if (!isValidFilename(filename)) {
    socket.emit('error', 'Invalid filename. Only alphanumeric, dashes, underscores allowed and must end with .ipxe or .cfg');
    return;
  }
  // Security check
  if (!filePath.startsWith(rootDir)) {
    socket.emit('error-message', 'Invalid file path');
    return;
  }
  try {
    fs.writeFileSync(filePath, '#!ipxe');
    console.log( filename  + ' created successfully');
  } catch (err) {
    console.error('Failed to create iPXE file:', err);
    socket.emit('error-message', 'Failed to create iPXE file: ' + err.message);
    return;
  }

  // Call layermenu and finish
  layermenu(() => {
    disablesigs();
    editgetfile(filename, true, socket); // Load the newly created file for editing
  }, socket, null);
}

// When save is requested save it sync files and return user to menu
function saveconfig(filename, text, socket, io) {
  const rootDir = '/config/menus/local/';
  const filePath = path.resolve(rootDir, filename);
  // Security check
  if (!filePath.startsWith(rootDir)) {
    io.sockets.in(socket.id).emit('error', 'Invalid file path');
    return;
  }
  try {
    fs.writeFileSync(filePath, text);
  } catch (err) {
    console.error('Failed to save iPXE file:', err);
    socket.emit('error', 'Failed to save iPXE file: ' + err.message);
  }

  // Call layermenu and finish
  layermenu(() => {
    disablesigs();
    console.log( filename + ' saved');
  }, socket, null);
}

// When revert is requested delete it, sync files and return user to menu
function revertconfig(filename, socket, io) {
  const rootDir = '/config/menus/local/';
  const filePath = path.resolve(rootDir, filename);
  // Security check
  if (!filePath.startsWith(rootDir)) {
    io.sockets.in(socket.id).emit('error', 'Invalid file path');
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    console.error('Failed to revert iPXE file:', err);
    socket.emit('error', 'Failed to revert iPXE file: ' + err.message);
  }

  // Call layermenu and finish
  layermenu(() => {
    disablesigs();
    console.log( filename + ' reverted to local');
  }, socket, null);
}

function editgetfile(filename, islocal, socket) {
  const rootDir = '/config/menus/';
  const filePath = path.resolve(rootDir, filename);

  // Security check
  if (!filePath.startsWith(rootDir)) {
    return socket.emit('error', 'Invalid file path');
  }

  try {
    const data = fs.readFileSync(filePath);
    const stat = fs.lstatSync(filePath);

    isBinaryFile(data, stat.size).then(result => {
      if (result) {
        socket.emit('editrenderfile', 'CANNOT EDIT THIS IS A BINARY FILE', filename, 'nomenu');
      } else {
        socket.emit('editrenderfile', data.toString('utf8'), filename, islocal);
      }
    });
  } catch (err) {
    console.error('Failed to read file:', err);
    socket.emit('error', 'Failed to read file: ' + err.message);
  }
}

module.exports = {
  getMenuVersion,
  getMenuOrigin,
  disablesigs,
  layermenu,
  fetchDevReleases,
  fetchNetbootReleases,
  upgrademenu,
  upgrademenunetboot,
  emptymenu,
  createipxe,
  saveconfig,
  revertconfig,
  editgetfile,
};
