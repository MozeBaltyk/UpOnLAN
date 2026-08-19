// ./services/menuServices.js
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yaml = require('js-yaml');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { isBinaryFile } = require('isbinaryfile');
// Containers mount these volumes; overridable so tests run against fixtures.
const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
const ASSETS_ROOT = process.env.UPONLAN_ASSETS || '/assets';
const MENU_DIR = path.join(CONFIG_ROOT, 'menus');
const ENDPOINTS_CONFIG = path.join(CONFIG_ROOT, 'endpoints.yml');
const MENU_CONFIG = path.join(CONFIG_ROOT, 'menu.yml');
const { 
  downloader,
  deleteAllFilesInDir,
  deleteFiles,
  getLocalNginx,
  getMenuVersion,
  getEndpointUrls,
  logWithTimestamp,
  errorWithTimestamp,
 } = require('./utilServices');
const { startBuild, cancelBuild } = require('./romBuildService');

async function runBuildPlaybook(formats, socket) {
  // Build ROMs/boot media via scripts/build_ipxe_roms.sh (no Ansible).
  const result = await startBuild(formats, socket, (progress) => {
    socket.emit('buildProgress', progress);
  });
  return result;
}

async function cancelBuildPlaybook(socket) {
  const result = await cancelBuild();
  socket.emit('buildMenuResult', {
    success: result.success,
    status: result.status || (result.success ? 'success' : 'error'),
    message: result.message,
    pid: result.pid || null,
  });
  return result;
}

// Fetch development releases
async function fetchDevReleases() {
  const { api_url, latest_url, menu_download_base } = getEndpointUrls();
  const options = { headers: { 'user-agent': 'node.js' } };

  let releases;
  try {
    // GitHub-style API: GET /releases returns a JSON array.
    const releasesResponse = await fetch(api_url + 'releases', options);
    if (!releasesResponse.ok) {
      throw new Error(`GitHub API error fetching ${api_url}. Status: ${releasesResponse.status}`);
    }
    releases = await releasesResponse.json();
    if (!Array.isArray(releases)) {
      throw new Error(`Endpoint ${api_url} did not return a release list`);
    }
  } catch (err) {
    // Flat-file mirrors (deploy --local) serve /releases as an HTML directory
    // listing, not a JSON API. Fall back to the latest-version file that the
    // release scripts write into the mirror.
    const latest = await fetch(latest_url, options)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (latest && latest.tag_name) {
      releases = [{
        tag_name: latest.tag_name,
        html_url: `${menu_download_base}/${latest.tag_name}/`,
      }];
    } else {
      throw new Error(`No releases found at ${api_url}. Expected a GitHub API or a mirror with a latest file.`);
    }
  }
  return releases;
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
async function upgrademenu(version, callback, socket) {
  const { endpoint_url, menu_download_base } = getEndpointUrls();
  const remote_folder = path.join(MENU_DIR, 'remote') + path.sep;
  const targetDir = MENU_DIR + path.sep;

  try {
    // Clean folders
    await deleteAllFilesInDir(targetDir);

    // Wipe current remote
    const remote_files = await fsp.readdir(remote_folder, { withFileTypes: true });
    for (const file of remote_files) {
      if (!file.isDirectory()) {
        await fsp.unlink(path.join(remote_folder, file.name));
      }
    }

    // Download menus.tar.gz  
    const downloads = [{
      url: `${menu_download_base}/${version}/menus.tar.gz`,
      path: remote_folder,
    }];

    await downloader(downloads, socket);

    // Extract tar file and cleanup
    const tarFile = path.join(remote_folder, 'menus.tar.gz');
    const untarcmd = `tar xf ${tarFile} -C ${remote_folder}`;
    await exec(untarcmd);
    await fsp.unlink(tarFile);

    // Write menu metadata only; asset endpoints are managed separately.
    const origin = endpoint_url;
    await fsp.writeFile(MENU_CONFIG, yaml.dump({ menu: { origin, version } }));

    //  layermenu using Promise wrapper
    await layermenu(socket, null);
    await disablesigs();
    logWithTimestamp(`Menu upgraded to version ${version} from ${endpoint_url}`);
    callback(null, 'success');
  } catch (err) {
    errorWithTimestamp("Error during upgrademenu:", err);
    callback(err);
  }
}

// Upgrade menu function from Netboot.xyz repository
async function upgrademenunetboot(version, callback, socket) {
  const remote_folder = path.join(MENU_DIR, 'remote') + path.sep;
  const targetDir = MENU_DIR + path.sep;

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

    await downloader(downloads, socket)

    const tarFile = path.join(remote_folder, 'menus.tar.gz');
    await exec(`tar xf ${tarFile} -C ${remote_folder}`);
    await fsp.unlink(tarFile);
    const displayVersion = isCommitSha ? 'Development' : version;
    await fsp.writeFile(MENU_CONFIG, yaml.dump({ menu: { origin, version: displayVersion } }));
  
    await layermenu(socket, null);
    await disablesigs();

    logWithTimestamp(`Menu upgraded to version ${version} from ${origin}`);
    callback(null, 'success');
  } catch (err) {
    errorWithTimestamp("Error during upgrademenunetboot:", err);
    callback(err);
  }
}

// Empty Menu
async function emptymenu(socket) {
    try {
      // Delete all files in local and remote directories
      await deleteAllFilesInDir(path.join(MENU_DIR, 'local'));
      await deleteAllFilesInDir(path.join(MENU_DIR, 'remote'));
      await deleteAllFilesInDir(MENU_DIR);
      await deleteAllFilesInDir(path.join(ASSETS_ROOT, 'ipxe'));
      await deleteFiles(path.join(ASSETS_ROOT, 'index.html'));
      await deleteFiles(path.join(ASSETS_ROOT, 'index.htm'));
      await deleteFiles(MENU_CONFIG);
      await fsp.rm(path.join(MENU_DIR, 'remote/sigs'), { recursive: true, force: true });
      await fsp.rm(path.join(MENU_DIR, 'rom'), { recursive: true, force: true });

      // get default
      const { endpoint_url } = getEndpointUrls();
      await fsp.writeFile(MENU_CONFIG, yaml.dump({ menu: { origin: endpoint_url } }), 'utf8');
      logWithTimestamp(`menu.yml reset with origin: ${endpoint_url}`);
      // Render empty menu
      await layermenu(socket, null);
    } catch (err) {
      errorWithTimestamp('Failed to reset menu:', err);
      socket.emit('error', 'Failed to reset menu: ' + err.message);
    }
}

// Disable sigs by editing boot.cfg files
async function disablesigs() {
  const bootcfgr = path.join(MENU_DIR, 'remote/boot.cfg');
  const bootcfgl = path.join(MENU_DIR, 'local/boot.cfg');
  const bootcfgm = path.join(MENU_DIR, 'boot.cfg');
  try {
    const fileExists = await fsp.stat(bootcfgr).then(() => true).catch(() => false);
    const localExists = await fsp.stat(bootcfgl).then(() => true).catch(() => false);
    if (fileExists && !localExists) {
      const data = await fsp.readFile(bootcfgr, 'utf8');
      const disable = data.replace(/set sigs_enabled true/g, 'set sigs_enabled false');
      await fsp.writeFile(bootcfgr, disable, 'utf8');
      await fsp.writeFile(bootcfgm, disable, 'utf8');
    }
  } catch (err) {
    errorWithTimestamp('Error disabling sigs:', err);
  }
}

// Fully promisified layermenu
async function layermenu(socket = null, filename = null) {
  const targetDir = path.resolve(MENU_DIR);
  const romDir = path.resolve(MENU_DIR, 'rom/ipxe'); // ROM files are here
  const indexDir = path.resolve(MENU_DIR, 'rom'); // Index files 

  const { local_files, remote_files } = await getipxefiles();
  const { list_rom_files } = await getremoteromfiles();
  const { list_index_files } = await getremoteindexfiles();
  const local_nginx_url = getLocalNginx();
  const menu_version = getMenuVersion();

  // Copy remote iPXE files to targetDir
  for (const file of remote_files) {
    await fsp.copyFile(path.join(getLayerRoot(false), file), path.join(targetDir, file));
  }
  // Copy remote iPXE files to targetDir
  for (const file of local_files) {
    await fsp.copyFile(path.join(getLayerRoot(true), file), path.join(targetDir, file));
  }
  // Copy remote ROM to romDir
  for (const file of list_rom_files) {
    await fsp.copyFile(path.join(getLayerRoot(false), file), path.join(romDir, file));
  }
  // Copy remote index files to indexDir
  for (const file of list_index_files) {
    await fsp.copyFile(path.join(getLayerRoot(false), file), path.join(indexDir, file));
  }

  if (socket) {
    socket.emit('renderconfig', remote_files, local_files, list_rom_files, list_index_files, local_nginx_url, menu_version);
  }
}

// Helper to validate file names against allowed extensions
function isValidFile(filename, exts) {
  const pattern = new RegExp(`^[\\w.-]+\\.(${exts.join('|')})$`);
  return pattern.test(filename);
}

// Helper to get the absolute root path for a given layer
function getLayerRoot(islocal) {
  return path.resolve(MENU_DIR, islocal ? 'local' : 'remote') + path.sep;
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
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter(d => !d.isDirectory() && isValidFile(d.name, exts))
      .map(d => d.name);
  } catch (err) {
    errorWithTimestamp(`Failed to read directory ${dir}:`, err);
    return [];
  }
}

// Get iPXE files from local and remote layers
async function getipxefiles() {
  const local_files = await listFiles(getLayerRoot(true), ['ipxe', 'cfg']);
  const remote_files = await listFiles(getLayerRoot(false), ['ipxe', 'cfg']);
  return { local_files, remote_files };
}

// Get ROM files
async function getromfiles() {
  const romDir = path.resolve(MENU_DIR, 'rom/ipxe');
  // Make sure all destination directories exist
  await fsp.mkdir(romDir, { recursive: true });
  const list_rom_files = await listFiles(romDir, ['efi', 'kpxe', 'dsk', 'pdsk', 'iso', 'img']);
  return { list_rom_files };
}

async function getindexfiles() {
  const assetsDir = path.resolve(MENU_DIR, 'rom');
  // Make sure all destination directories exist
  await fsp.mkdir(assetsDir, { recursive: true });
  const list_index_files = await listFiles(assetsDir, ['html', 'htm']);
  return { list_index_files };
}

async function getremoteromfiles() {
  const remoteDir = path.resolve(MENU_DIR, 'remote');
  // Make sure all destination directories exist
  await fsp.mkdir(remoteDir, { recursive: true });
  const list_rom_files = await listFiles(remoteDir, ['efi', 'kpxe', 'dsk', 'pdsk', 'iso', 'img']);
  return { list_rom_files };
}

async function getremoteindexfiles() {
  const remoteDir = path.resolve(MENU_DIR, 'remote');
  // Make sure all destination directories exist
  await fsp.mkdir(remoteDir, { recursive: true });
  const list_index_files = await listFiles(remoteDir, ['html', 'htm']);
  return { list_index_files };
}

// Read file contents for editing, from local or remote layer
async function editgetfile(filename, islocal, socket) {
  const filePath = getMenuFilePath(filename, islocal);
  if (!isPathValid(filePath, islocal)) {
    socket.emit('error', 'Invalid file path');
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    const stat = await fsp.stat(filePath);
    const isBinary = await isBinaryFile(data, stat.size);
    if (isBinary) {
      socket.emit('editrenderfile', 'CANNOT EDIT THIS IS A BINARY FILE', filename, 'nomenu');
    } else {
      socket.emit('editrenderfile', data.toString('utf8'), filename, islocal);
    }
  } catch (err) {
    errorWithTimestamp('Failed to read file:', err);
    socket.emit('error', 'Failed to read file: ' + err.message);
  }
}

// Create a new empty iPXE file (always local layer)
async function createipxe(filename, socket) {
  const islocal = true;
  const filePath = getMenuFilePath(filename, islocal);

  if (!isValidFile(filename, ['ipxe', 'cfg']) || !isPathValid(filePath, islocal)) {
    socket.emit('error', 'Invalid file path or filename');
    return;
  }

  try {
    await fsp.writeFile(filePath, '#!ipxe');
    await layermenu(socket, filename);
    await disablesigs();
  } catch (err) {
    errorWithTimestamp('Failed to create iPXE file:', err);
    socket.emit('error', 'Failed to create iPXE file: ' + err.message);
  }
}

// Save edited content to a local file
async function saveconfig(filename, text, socket) {
  const islocal = true;
  const filePath = getMenuFilePath(filename, islocal);
  if (!isPathValid(filePath, islocal)) {
    errorWithTimestamp('Invalid file path');
    socket.emit('error', 'Invalid file path');
    return;
  }
  try {
    await fsp.writeFile(filePath, text);
    await layermenu(socket, filename);
    await disablesigs();
  } catch (err) {
    errorWithTimestamp('Failed to save iPXE file:', err);
    socket.emit('error', 'Failed to save iPXE file: ' + err.message);
  }
}

// Revert local override by deleting local file (restoring remote base)
async function revertconfig(filename, socket) {
  const islocal = true;
  const filePath = getMenuFilePath(filename, islocal);

  if (!isPathValid(filePath, islocal)) {
    errorWithTimestamp('Invalid file path');
    socket.emit('error', 'Invalid file path');
    return;
  }
  try {
    await fsp.unlink(filePath);
    await layermenu(socket, null);
    await disablesigs();
    logWithTimestamp(`${filename} reverted to remote version`);
  } catch (err) {
    errorWithTimestamp('Failed to revert iPXE file:', err);
    socket.emit('error', 'Failed to revert iPXE file: ' + err.message);
  }
}

module.exports = {
  runBuildPlaybook,
  cancelBuildPlaybook,
  disablesigs,
  layermenu,
  fetchDevReleases,
  fetchNetbootReleases,
  upgrademenu,
  upgrademenunetboot,
  emptymenu,
  getipxefiles,
  getromfiles,
  getindexfiles,
  editgetfile,
  createipxe,
  saveconfig,
  revertconfig,
};
