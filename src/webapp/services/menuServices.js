// ./services/menuServices.js
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { isBinaryFile } = require('isbinaryfile');
const { 
  downloader,
  deleteAllFilesInDir,
  deleteFiles,
  getEndpointUrls,
 } = require('./utilServices');

// Fetch development releases
async function fetchDevReleases() {
  const { api_url } = getEndpointUrls();
  const options = { headers: { 'user-agent': 'node.js' } };

  const releasesResponse = await fetch(api_url + 'releases', options);
  if (!releasesResponse.ok) {
    throw new Error(`GitHub API error fetching ${api_url}. Status: ${releasesResponse.status}`);
  }
  return releasesResponse.json();
}

// Fetch Netboot releases
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
  return { releases, commits };
}

// Upgrade menu function from given Endpoint
async function upgrademenu(version, callback, io, socket) {
  const { endpoint_url } = getEndpointUrls();
  const remote_folder = '/config/menus/remote/';
  const targetDir = '/config/menus/';
  const endpoint_config = '/config/endpoints.yml';

  try {
    // Clean folders
    await deleteAllFilesInDir(targetDir);
    await deleteFiles(endpoint_config);

    // Wipe current remote
    const remote_files = await fs.readdir(remote_folder, { withFileTypes: true });
    for (const file of remote_files) {
      if (!file.isDirectory()) {
        await fs.unlink(path.join(remote_folder, file.name));
      }
    }

    // Download menus.tar.gz  
    const downloads = [{
      url: `${endpoint_url}/releases/download/${version}/menus.tar.gz`,
      path: remote_folder,
    }];

    await downloader(downloads, io, socket);

    // Extract tar file and cleanup
    const tarFile = path.join(remote_folder, 'menus.tar.gz');
    const untarcmd = `tar xf ${tarFile} -C ${remote_folder}`;
    await exec(untarcmd);
    await fs.unlink(tarFile);

    // Write version and origin to config files
    const origin = endpoint_url;
    const remote_endpoints_config = path.join(remote_folder, 'endpoints.yml');

    let yamlData = {};
    try {
      const fileContent = await fs.readFile(remote_endpoints_config, 'utf8');
      yamlData = yaml.load(fileContent) || {};
    } catch {
      yamlData = {};
    }

    // Ensure endpoints array exists
    if (!yamlData.endpoints) {
      yamlData.endpoints = [];
    }

    // Always update menu
    yamlData.menu = { origin, version };

    // Write full YAML to endpoint config
    await fs.writeFile(endpoint_config, yaml.dump(yamlData));

    //  layermenu using Promise wrapper
    await layermenu(socket, null);
    await disablesigs();
    console.log(`Menu upgraded to version ${version} from ${endpoint_url}`);
  } catch (err) {
    console.error("Error during upgrademenu:", err);
    callback(err);
  }
}

// Upgrade menu function from Netboot.xyz repository
async function upgrademenunetboot(version, io, socket) {
  const remote_folder = '/config/menus/remote/';
  const targetDir = '/config/menus/';
  const endpoint_config = '/config/endpoints.yml';

  try {
    await deleteAllFilesInDir(targetDir);
    await deleteAllFilesInDir(remote_folder);

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

    for (const file of rom_files) {
      downloads.push({ url: download_endpoint + file, path: remote_folder });
    }

    downloads.push({
      url: `https://raw.githubusercontent.com/netbootxyz/netboot.xyz/${version}/endpoints.yml`,
      path: '/config/',
    });

    await downloader(downloads, io, socket)

    const tarFile = path.join(remote_folder, 'menus.tar.gz');
    await exec(`tar xf ${tarFile} -C ${remote_folder}`);
    await fs.unlink(tarFile);
    const displayVersion = isCommitSha ? 'Development' : version;
  
    let yamlData = {};
    try {
      const fileContent = await fs.readFile(endpoint_config, 'utf8');
      yamlData = yaml.load(fileContent) || {};
    } catch {
      yamlData = {};
    }
    if (!yamlData.endpoints) {
      yamlData.endpoints = [];
    }
    yamlData.menu = { origin, version: displayVersion };
    await fs.writeFile(endpoint_config, yaml.dump(yamlData));
  
    await layermenu(socket, null);
    await disablesigs();

    console.log(`Menu upgraded to version ${version} from ${origin}`);
  } catch (err) {
    console.error("Error during upgrademenunetboot:", err);
    throw err;
  }
}

// Empty Menu
async function emptymenu(socket, io) {
    const endpoints_config = '/config/endpoints.yml';
    try {
      // Delete all files in local and remote directories
      await deleteAllFilesInDir('/config/menus/local');
      await deleteAllFilesInDir('/config/menus/remote');
      await deleteAllFilesInDir('/config/menus');
      await deleteFiles('/config/menuversion.txt');
      await deleteFiles('/config/menuorigin.txt');
      await deleteFiles(endpoints_config);

      // get default
      const { endpoint_url } = getEndpointUrls();
      const yamlData = { endpoints: [], menu: { origin: endpoint_url } };
      await fs.writeFile(endpoints_config, yaml.dump(yamlData), 'utf8');
      console.log(`endpoints.yml reset with origin: ${endpoint_url}`);
      // Render empty menu
      await layermenu(socket, null);
    } catch (err) {
      console.error('Failed to reset menu:', err);
      socket.emit('error', 'Failed to reset menu: ' + err.message);
    }
}

// Disable sigs by editing boot.cfg files
async function disablesigs() {
  const bootcfgr = '/config/menus/remote/boot.cfg';
  const bootcfgl = '/config/menus/local/boot.cfg';
  const bootcfgm = '/config/menus/boot.cfg';
  try {
    const fileExists = await fs.stat(bootcfgr).then(() => true).catch(() => false);
    const localExists = await fs.stat(bootcfgl).then(() => true).catch(() => false);
    if (fileExists && !localExists) {
      const data = await fs.readFile(bootcfgr, 'utf8');
      const disable = data.replace(/set sigs_enabled true/g, 'set sigs_enabled false');
      await fs.writeFile(bootcfgr, disable, 'utf8');
      await fs.writeFile(bootcfgm, disable, 'utf8');
    }
  } catch (err) {
    console.error('Error disabling sigs:', err);
  }
}

// Fully promisified layermenu
async function layermenu(socket = null, filename = null) {
  const targetDir = path.resolve('/config/menus/');
  const romDir = path.resolve('/config/menus/rom'); // ROM files are here

  const { local_files, remote_files } = await getipxefiles();
  const { list_rom_files } = await getremoteromfiles();

  // Copy remote iPXE files to targetDir
  for (const file of remote_files) {
    await fs.copyFile(path.join(getLayerRoot(false), file), path.join(targetDir, file));
  }
  // Copy remote iPXE files to targetDir
  for (const file of local_files) {
    await fs.copyFile(path.join(getLayerRoot(true), file), path.join(targetDir, file));
  }
  // Copy remote ROM to romDir
  for (const file of list_rom_files) {
    await fs.copyFile(path.join(getLayerRoot(false), file), path.join(romDir, file));
  }
  if (socket) {
    socket.emit('renderconfig', remote_files, local_files, list_rom_files);
  }
}

// Helper to validate file names against allowed extensions
function isValidFile(filename, exts) {
  const pattern = new RegExp(`^[\\w.-]+\\.(${exts.join('|')})$`);
  return pattern.test(filename);
}

// Helper to get the absolute root path for a given layer
function getLayerRoot(islocal) {
  return path.resolve('/config/menus/', islocal ? 'local' : 'remote') + path.sep;
}

// Helper to get the full file path for a given filename and layer
function getMenuFilePath(filename, islocal) {
  const rootDir = getLayerRoot(islocal);
  return path.resolve(rootDir, filename);
}

// Helper to check if a path is inside the layer root folder (prevents directory traversal)
function isPathValid(filepath, islocal) {
  const root = getLayerRoot(islocal);
  return filepath.startsWith(root);
}

// List files in a directory filtering by extensions
async function listFiles(dir, exts) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(d => !d.isDirectory() && isValidFile(d.name, exts))
      .map(d => d.name);
  } catch (err) {
    console.error(`Failed to read directory ${dir}:`, err);
    return [];
  }
}

// Get iPXE files from local and remote layers
async function getipxefiles() {
  const local_files = await listFiles(getLayerRoot(true), ['ipxe', 'cfg']);
  const remote_files = await listFiles(getLayerRoot(false), ['ipxe', 'cfg']);
  return { local_files, remote_files };
}

// Get ROM files (only from /config/menus, presumably remote base)
async function getromfiles() {
  const dir = path.resolve('/config/menus/rom');
  const list_rom_files = await listFiles(dir, ['efi', 'kpxe', 'dsk', 'pdsk', 'iso', 'img']);
  return { list_rom_files };
}

async function getremoteromfiles() {
  const dir = path.resolve('/config/menus/remote');
  const list_rom_files = await listFiles(dir, ['efi', 'kpxe', 'dsk', 'pdsk', 'iso', 'img']);
  return { list_rom_files };
}

// Read file contents for editing, from local or remote layer
async function editgetfile(filename, islocal, socket) {
  const filePath = getMenuFilePath(filename, islocal);
  if (!isPathValid(filePath, islocal)) {
    socket.emit('error', 'Invalid file path');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    const isBinary = await isBinaryFile(data, stat.size);
    if (isBinary) {
      socket.emit('editrenderfile', 'CANNOT EDIT THIS IS A BINARY FILE', filename, 'nomenu');
    } else {
      socket.emit('editrenderfile', data.toString('utf8'), filename, islocal);
    }
  } catch (err) {
    console.error('Failed to read file:', err);
    socket.emit('error', 'Failed to read file: ' + err.message);
  }
}

// Create a new empty iPXE file (always local layer)
async function createipxe(filename, socket, io) {
  const islocal = true;
  const filePath = getMenuFilePath(filename, islocal);

  if (!isValidFile(filename, ['ipxe', 'cfg']) || !isPathValid(filePath, islocal)) {
    socket.emit('error', 'Invalid file path or filename');
    return;
  }

  try {
    await fs.writeFile(filePath, '#!ipxe');
    await layermenu(socket, filename);
    await disablesigs();
  } catch (err) {
    console.error('Failed to create iPXE file:', err);
    socket.emit('error', 'Failed to create iPXE file: ' + err.message);
  }
}

// Save edited content to a local file
async function saveconfig(filename, text, socket, io) {
  const islocal = true;
  const filePath = getMenuFilePath(filename, islocal);

  if (!isPathValid(filePath, islocal)) {
    io.sockets.in(socket.id).emit('error', 'Invalid file path');
    return;
  }

  try {
    await fs.writeFile(filePath, text);
    await layermenu(socket, filename);
    await disablesigs();
  } catch (err) {
    console.error('Failed to save iPXE file:', err);
    socket.emit('error', 'Failed to save iPXE file: ' + err.message);
  }
}

// Revert local override by deleting local file (restoring remote base)
async function revertconfig(filename, socket, io) {
  const islocal = true;
  const filePath = getMenuFilePath(filename, islocal);

  if (!isPathValid(filePath, islocal)) {
    io.sockets.in(socket.id).emit('error', 'Invalid file path');
    return;
  }

  try {
    await fs.unlink(filePath);
    await layermenu(socket, null);
    await disablesigs();
    console.log(`${filename} reverted to remote version`);
  } catch (err) {
    console.error('Failed to revert iPXE file:', err);
    socket.emit('error', 'Failed to revert iPXE file: ' + err.message);
  }
}



module.exports = {
  disablesigs,
  layermenu,
  fetchDevReleases,
  fetchNetbootReleases,
  upgrademenu,
  upgrademenunetboot,
  emptymenu,
  getipxefiles,
  getromfiles,
  editgetfile,
  createipxe,
  saveconfig,
  revertconfig,
};
