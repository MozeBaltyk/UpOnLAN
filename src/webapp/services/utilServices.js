// ./services/utilServices.js
'use strict';
const { DownloaderHelper } = require('node-downloader-helper');
const urlLib = require('url');
const fetch = require('node-fetch');
const allowedHosts = ['github.com', 's3.amazonaws.com'];
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const exec = require('child_process').exec;
// Root of the config volume; overridable so tests run against fixtures.
const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
let cachedNginxURL = null;
function logWithTimestamp(...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}]`, ...args);
}

function errorWithTimestamp(...args) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}]`, ...args);
}

function execCommand(cmd) {
  return new Promise(resolve => {
    exec(cmd, (err, stdout, stderr) => {
      resolve((stdout || stderr || '').trim());
    });
  });
}

function isValidUrl(urlString) {
  try {
    new URL(urlString); // Will throw if invalid
    return true;
  } catch (err) {
    return false;
  }
}

// Menu releases use a bare semver tag (0.0.2); asset bundles get one release per
// OS key (proxmox-ve-8.4-1-x86_64). Both share the GitHub releases namespace, so
// menu-version listings must ignore non-semver tags.
function isMenuVersionTag(tag) {
  return /^v?\d+\.\d+\.\d+$/.test(String(tag || ''));
}

function getMenuData() {
  const menuPath = path.join(CONFIG_ROOT, 'menu.yml');
  if (!fs.existsSync(menuPath)) return { version: 'none', origin: 'none' };

  try {
    const fileContent = fs.readFileSync(menuPath, 'utf8');
    const yamlData = yaml.load(fileContent);
    const menu = yamlData?.menu || {};
    return {
      version: menu.version || 'none',
      origin: menu.origin || 'none'
    };
  } catch (err) {
    console.error('Error reading menu config:', err.message);
    return { version: 'none', origin: 'none' };
  }
}

function getMenuVersion() {
  return getMenuData().version;
}

function getMenuOrigin() {
  return getMenuData().origin.replace(/\/+$/, '');
}

function getAssetOrigin() {
  const origin = getMenuData().origin;
  if (origin === 'none') return 'none';

  try {
    const parsedUrl = new URL(origin);
    if (parsedUrl.hostname === 'github.com' && parsedUrl.pathname.startsWith('/netbootxyz')) {
      return 'https://github.com/netbootxyz';
    }
    // No trailing slash: callers append path segments (e.g. `origin + path`),
    // and `new URL(...).toString()` adds a trailing slash for root paths,
    // producing a `//` double-slash.
    return parsedUrl.toString().replace(/\/+$/, '');
  } catch (err) {
    console.error('Invalid URL in menu config:', err.message);
    return origin;
  }
}

function getLocalNginx() {
  // Return cached result if available
  if (cachedNginxURL) {
    return cachedNginxURL;
  }

  const configPath = path.join(CONFIG_ROOT, 'nginx/site-confs/default');

  try {
    const configContent = fs.readFileSync(configPath, 'utf8');

    // Match all 'listen' directives: port and whether 'ssl' is present
    const listenRegex = /^\s*listen\s+(?:[^\s:]*:)?(\d+)(?:[^;]*?\bssl\b)?[^;]*;/gm;
    let match;
    let selected = null;

    while ((match = listenRegex.exec(configContent)) !== null) {
      const port = match[1];
      const line = match[0];

      if (port) {
        const isSSL = /\bssl\b/.test(line);
        selected = {
          port,
          protocol: isSSL ? 'https' : 'http',
        };
        // Prefer non-443 SSL or any HTTP on first match
        if (!isSSL || port !== '443') break;
      }
    }

    if (selected) {
      cachedNginxURL = `${selected.protocol}://localhost:${selected.port}`;
    } else {
      console.warn(`No valid 'listen' directive found in ${configPath}.`);
      cachedNginxURL = 'http://localhost';
    }

    return cachedNginxURL;
  } catch (err) {
    console.error(`Error reading NGINX config at ${configPath}:`, err.message);
    cachedNginxURL = 'http://localhost';
    return cachedNginxURL;
  }
}

function getEndpointUrls() {
  // if not defined in /config/menuorigin.txt, let endpoint_url = process.env.ENDPOINT_URL;
  const defaultEndpointUrl = "https://github.com/mozebaltyk/uponlan";
  let endpoint_url = getMenuOrigin();
  if (endpoint_url === 'none' || !isValidUrl(endpoint_url)) {
    console.warn(`Invalid or missing origin in endpoints.yml. Using default URL ${defaultEndpointUrl}.`);
    endpoint_url = defaultEndpointUrl;
  }

  // Normalize: remove trailing slashes
  endpoint_url = endpoint_url.replace(/\/+$/, '');

  // Define API and raw URLs based on endpoint_url
  let api_url, raw_url, latest_url, menu_download_base;
  const isGitHub = endpoint_url.startsWith("https://github.com/");
  if (isGitHub) {
    // For GitHub, construct API and raw URLs
    const match = endpoint_url.match(/github\.com\/([^\/]+)\/([^\/]+)(\/)?$/);
    if (match) {
      const user = match[1];
      const repo = match[2];
      api_url = `https://api.github.com/repos/${user}/${repo}/`;
      raw_url = `https://raw.githubusercontent.com/${user}/${repo}/main/`;
    } else {
      console.warn(`Could not extract user/repo from GitHub URL: ${endpoint_url}`);
      api_url = endpoint_url;
      raw_url = endpoint_url;
    }
    // GitHub: menu tarball lives with the release assets.
    latest_url = `${api_url}releases/latest`;
    menu_download_base = `${endpoint_url}/releases/download`;
  } else {
    // For local mirrors / non-GitHub endpoints, keep a trailing slash so
    // callers can append path segments safely (e.g. `${api_url}releases`).
    api_url = `${endpoint_url}/`;
    raw_url = api_url;
    // Local mirror splits menu/ from assets/.
    latest_url = `${api_url}menu/latest`;
    menu_download_base = `${endpoint_url}/menu`;
  }

  // console.log("API URL:", api_url);
  // console.log("RAW URL:", raw_url);
  // console.log("Endpoint URL:", endpoint_url);
  return { endpoint_url, api_url, raw_url, latest_url, menu_download_base };
}


function deleteAllFilesInDir(dir) {
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      if (fs.lstatSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        console.log('Deleted', filePath);
      }
    });
  }
}

function deleteFiles(file) {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log('Deleted', file);
  }
}

async function downloader(downloads, socket) {
  let startTime = new Date();
  const total = downloads.length;

  for (let i = 0; i < downloads.length; i++) {
    const { url, path } = downloads[i];
    const dloptions = {
      override: true,
      retry: { maxRetries: 2, delay: 5000 }
    };

    const dl = new DownloaderHelper(url, path, dloptions);

    dl.on('end', () => {
      console.log(`Downloaded ${url} to ${path}`);
    });

    dl.on('error', (error) => {
      console.error(`Download failed: ${url}`, error.message);
    });

    dl.on('progress', (stats) => {
      const currentTime = new Date();
      const elapsedTime = currentTime - startTime;
      if (elapsedTime > 100) {
        startTime = currentTime;
        socket.emit('dldata', url, [i + 1, total], stats);
      }
    });

    try {
      await dl.start();
    } catch (err) {
      throw new Error(`Download failed: ${url} -> ${err.message}`);
    }

    // Optional .part2 support (for non-GitHub/S3 hosts)
    const parsedUrl = urlLib.parse(url);
    if (!allowedHosts.includes(parsedUrl.host)) {
      try {
        const response = await fetch(url + '.part2', { method: 'HEAD' });
        const serverHeader = response.headers.get('server');
        if (['AmazonS3', 'Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0'].includes(serverHeader)) {
          const dl2 = new DownloaderHelper(url + '.part2', path, dloptions);

          dl2.on('end', () => {
            console.log(`Downloaded ${url}.part2 to ${path}`);
          });

          dl2.on('progress', (stats) => {
            const currentTime = new Date();
            const elapsedTime = currentTime - startTime;
            if (elapsedTime > 100) {
              startTime = currentTime;
              socket.emit('dldata', url + '.part2', [i + 1, total], stats);
            }
          });

          await dl2.start();
        }
      } catch (err) {
        // silently skip .part2 if not found or failed
      }
    }
  }

  socket.emit('purgestatus');
}

module.exports = {
  logWithTimestamp,
  errorWithTimestamp,
  execCommand,
  getMenuVersion,
  getMenuOrigin,
  getAssetOrigin,
  getLocalNginx,
  isValidUrl,
  isMenuVersionTag,
  getEndpointUrls,
  deleteAllFilesInDir,
  deleteFiles,
  downloader,
};
