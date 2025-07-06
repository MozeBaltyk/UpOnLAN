// ./services/utilServices.js
const { DownloaderHelper } = require('node-downloader-helper');
const urlLib = require('url');
const fetch = require('node-fetch');
const allowedHosts = ['github.com', 's3.amazonaws.com'];
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const exec = require('child_process').exec;
const { promisify } = require('util');
const execPromise = promisify(exec);
const { spawn } = require('child_process');
let cachedNginxURL = null;
let ansibleState = {
  process: null,
  pid: null,
  startedBy: null,
  startTime: null,
  currentPlaybook: null,
};

async function startAnsiblePlaybook(playbookPath, options, socket, progressCallback) {
    if (ansibleState.process) {
        return { success: false, message: `Ansible already running (PID ${ansibleState.pid})` };
    }
    const { process, promise } = await runAnsiblePlaybook(playbookPath, options, socket, progressCallback);

    logWithTimestamp(`Starting playbook: ${playbookPath} with PID ${process.pid}`);

    ansibleState = {
        process,
        pid: process.pid,
        startedBy: socket.id,
        startTime: new Date(),
        currentPlaybook: playbookPath,
    };
    promise.finally(() => resetAnsibleState());

    return { success: true, message: `Build started (PID ${process.pid})`, pid: process.pid, promise };
}

function cancelAnsiblePlaybook() {
  if (!ansibleState.process) return { success: false, message: 'No active playbook running' };
  try {
    logWithTimestamp(`Cancelling playbook with PID ${ansibleState.pid}`);
    process.kill(-ansibleState.pid, 'SIGTERM');
  } catch (err) {
    errorWithTimestamp(`Failed to terminate process ${ansibleState.pid}:`, err.message);
    return { success: false, message: `Failed to terminate process: ${err.message}` };
  }
  resetAnsibleState();
  logWithTimestamp(`Playbook with PID ${ansibleState.pid} cancelled successfully`);
  return { success: true, message: 'Playbook cancelled' };
}

function resetAnsibleState() {
  ansibleState = { process: null, pid: null, startedBy: null, startTime: null, currentPlaybook: null };
}

async function runAnsiblePlaybook(playbookPath, options, socket, progressCallback) {
  const logDir = '/logs/ansible';
  await fs.promises.mkdir(logDir, { recursive: true });

  const extraVars = Object.entries(options)
    .map(([key, val]) => `${key}="${val}"`)
    .join(' ');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFilePath = path.join(logDir, `${path.basename(playbookPath)}_${timestamp}.log`);

  // Count tasks
  let taskCount = 0;
  try {
    const { stdout } = await execPromise(`sudo ansible-playbook ${playbookPath} --list-tasks`);
    const rawTaskCount = (stdout.match(/^\s{6,}.*$/gm) || []).length;
    taskCount = rawTaskCount * 7;
  } catch (err) {
    logWithTimestamp(`Failed to count tasks: ${err.message}`);
  }
  if (taskCount === 0) {
    logWithTimestamp('Warning: No tasks detected in playbook. Progress tracking may be inaccurate.');
  }

  // launch ansible-playbook with setsid to run it in a new session
  const args = [ playbookPath, '--extra-vars', extraVars];
  const ansible = spawn('setsid', ['sudo', 'ansible-playbook', ...args]);
  ansible.unref();

  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

  const promise = new Promise((resolve, reject) => {
    let tasksCompleted = 0;

    ansible.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        logStream.write(line + '\n');
        const taskMatch = line.match(/^TASK \[(.+)\]/);
        if (taskMatch && progressCallback) {
          taskCount++;
          progressCallback({ tasksCompleted, taskCount, currentTask: taskMatch[1] });
        }
        if (line.match(/^(ok|changed|failed):/)) {
          tasksCompleted++;
          if (progressCallback) {
            progressCallback({ tasksCompleted, taskCount, currentTask: null });
          }
        }
      });
    });

    ansible.stderr.on('data', (data) => {
      logStream.write(data);
    });

    ansible.on('close', (code, signal) => {
      logStream.end();
      if (signal === 'SIGTERM') {
        resolve({ success: false, message: 'Playbook cancelled by user.' });
      } else if (code === 0) {
        resolve({ success: true, message: `Playbook completed successfully: ${logFilePath}` });
      } else {
        resolve({ success: false, message: `Playbook failed. See log: ${logFilePath}` });
      }
    });

    ansible.on('error', (err) => {
      logStream.end();
      reject(new Error(`Failed to start Ansible process: ${err.message}`));
    });
  });

  return { process: ansible, promise };
}

async function hasOrphanProcesses() {
  const cmd = `ps -o pid,ppid,comm | awk '$2 == 1 && $1 != 1 && $3 ~ /ansible-play/'`;
  try {
    const { stdout } = await exec(cmd);
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

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

function getMenuData() {
  const configPath = '/config/endpoints.yml';
  if (!fs.existsSync(configPath)) {
    return { version: 'none', origin: 'none' };
  }

  try {
    const fileContent = fs.readFileSync(configPath, 'utf8');
    const yamlData = yaml.load(fileContent);
    const menu = yamlData?.menu || {};
    return {
      version: menu.version || 'none',
      origin: menu.origin || 'none'
    };
  } catch (err) {
    console.error('Error reading endpoints.yml:', err.message);
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
    return parsedUrl.toString();
  } catch (err) {
    console.error('Invalid URL in endpoints.yml:', err.message);
    return origin;
  }
}

function getLocalNginx() {
  // Return cached result if available
  if (cachedNginxURL) {
    return cachedNginxURL;
  }

  const configPath = '/config/nginx/site-confs/default';

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

  // console.log("API URL:", api_url);
  // console.log("RAW URL:", raw_url);
  // console.log("Endpoint URL:", endpoint_url);
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
      if (elapsedTime > 100) {
        startTime = currentTime;
        socket.emit('dldata', url, [i + 1, total], stats);
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
  startAnsiblePlaybook,
  cancelAnsiblePlaybook,
  hasOrphanProcesses,
  logWithTimestamp,
  errorWithTimestamp,
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