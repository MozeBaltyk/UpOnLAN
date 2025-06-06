// ./services/utilServices.js
const { DownloaderHelper } = require('node-downloader-helper');
const urlLib = require('url');
const fetch = require('node-fetch');
const allowedHosts = ['github.com', 's3.amazonaws.com'];
const fs = require('fs');
const path = require('path');
const exec = require('child_process').exec;

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

function getMenuVersion() {
  return fs.existsSync('/config/menuversion.txt') ? fs.readFileSync('/config/menuversion.txt', 'utf8') : 'none';
}

function getMenuOrigin() {
  const menuOriginPath = '/config/menuorigin.txt';
  if (!fs.existsSync(menuOriginPath)) return 'none';

  const rawUrl = fs.readFileSync(menuOriginPath, 'utf8').trim();
  return rawUrl.replace(/\/+$/, '');
}

function getAssetOrigin() {
  const filePath = '/config/menuorigin.txt';
  if (!fs.existsSync(filePath)) return 'none';

  const rawUrl = fs.readFileSync(filePath, 'utf8').trim();
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.hostname === 'github.com' && parsedUrl.pathname.startsWith('/netbootxyz')) {
      // Return only the base GitHub organization URL
      return 'https://github.com/netbootxyz';
    }
    return parsedUrl.toString();
  } catch (err) {
    console.error('Invalid URL in menuorigin.txt:', err.message);
    return rawUrl;
  }
}

function getLocalNginx() {
  const configPath = '/config/nginx/site-confs/default';
  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    // Regular expression to match the 'listen' directive and capture the port number
    const listenMatch = configContent.match(/^\s*listen\s+(\d+);/m);
    if (listenMatch && listenMatch[1]) {
      const port = listenMatch[1];
      return `http://localhost:${port}`;
    } else {
      console.warn('No listen directive found in NGINX config.');
      return 'http://localhost';
    }
  } catch (err) {
    console.error('Error reading NGINX config:', err.message);
    return 'http://localhost';
  }
}

function getEndpointUrls() {
  // let endpoint_url = process.env.ENDPOINT_URL;
  const defaultEndpointUrl = "https://github.com/mozebaltyk/uponlan";
  const menuOriginPath = '/config/menuorigin.txt';
  let endpoint_url;

  if (fs.existsSync(menuOriginPath)) {
    try {
      const rawUrl = fs.readFileSync(menuOriginPath, 'utf8').trim();
      if (isValidUrl(rawUrl)) {
        endpoint_url = rawUrl;
      } else {
        console.warn(`Invalid URL in menuorigin.txt: "${rawUrl}". Falling back to environment variable.`);
      }
    } catch (err) {
      console.error(`Error reading menuorigin.txt: ${err.message}`);
    }
  }

  if (!endpoint_url) {
    endpoint_url = process.env.ENDPOINT_URL;
    if (!endpoint_url || !isValidUrl(endpoint_url)) {
      console.warn(`Invalid or missing ENDPOINT_URL environment variable. Using default URL ${defaultEndpointUrl}.`);
      endpoint_url = defaultEndpointUrl;
    }
  }

  // Define API and raw URLs based on endpoint_url
  let api_url, raw_url;
  if (endpoint_url.startsWith("https://github.com/")) {
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
  } else {
    // For other endpoints, just use the base URL
    api_url = endpoint_url;
    raw_url = endpoint_url;
  }

  // Latest release URL
  latest_url = `${api_url}releases/latest`;

  //console.log("API URL:", api_url);
  //console.log("RAW URL:", raw_url);
  console.log("Endpoint URL:", endpoint_url);
  return { endpoint_url, api_url, raw_url, latest_url };
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

async function downloader(downloads, io, socket) {
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
      if (elapsedTime > 500) {
        startTime = currentTime;
        io.emit('dldata', url, [i + 1, total], stats);
      }
    });

    try {
      await dl.start();
    } catch (err) {
      console.error(`Download failed: ${url} -> ${err.message}`);
      continue; // move to next even on error
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
            if (elapsedTime > 500) {
              startTime = currentTime;
              io.emit('dldata', url + '.part2', [i + 1, total], stats);
            }
          });

          await dl2.start();
        }
      } catch (err) {
        // silently skip .part2 if not found or failed
      }
    }
  }

  io.emit('purgestatus');
}


module.exports = {
  execCommand,
  getMenuVersion,
  getMenuOrigin,
  getAssetOrigin,
  getLocalNginx,
  isValidUrl,
  getEndpointUrls,
  deleteAllFilesInDir,
  deleteFiles,
  downloader,
};