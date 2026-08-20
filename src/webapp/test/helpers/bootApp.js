// Boots the REAL app (app.js) on an ephemeral port against a fixture
// filesystem, with env set before require so module-level path constants
// point at the fixtures. Returns the server handle + a socket client factory.
'use strict';
const path = require('path');
const fs = require('fs');
const net = require('net');
const { io: ioClient } = require('socket.io-client');
const { createFixtureRoot } = require('./fixtures');

const WEBAPP_DIR = path.join(__dirname, '..', '..');

function clearAppCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(WEBAPP_DIR) && !key.includes(`${path.sep}node_modules${path.sep}`)) {
      delete require.cache[key];
    }
  }
}

async function bootApp({ user = 'admin', pass = 'secret', fixtures } = {}) {
  const root = createFixtureRoot(fixtures);

  Object.assign(process.env, {
    UPONLAN_CONFIG: path.join(root, 'config'),
    UPONLAN_ASSETS: path.join(root, 'assets'),
    UPONLAN_DOCS: path.join(root, 'docs'),
    UPONLAN_LOGS: path.join(root, 'logs'),
    NODE_ENV: 'test',
    SUBFOLDER: '/',
    WEBAPP_USER: user,
    WEBAPP_PASS: pass,
  });

  clearAppCache();
  const { http } = require(path.join(WEBAPP_DIR, 'app.js'));
  await new Promise((resolve) => http.listen(0, resolve));

  const baseUrl = `http://127.0.0.1:${http.address().port}`;

  return {
    root,
    baseUrl,
    http,
    connectClient(opts = {}) {
      return ioClient(baseUrl, { transports: ['websocket'], ...opts });
    },
    close: () =>
      new Promise((resolve) => {
        // closeAllConnections also kills keep-alive sockets left open by fetch()
        http.closeAllConnections?.();
        http.close(resolve);
      }),
  };
}

// Resolve a free TCP port (for the smoke test, which spawns `node app.js`).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Wait for a socket event or a timeout; rejects on 'connect_error'.
function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for '${event}'`));
    }, timeout);
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      clearTimeout(t);
      socket.off(event, onEvent);
      socket.off('connect_error', onError);
    }
    function onEvent(...args) {
      cleanup();
      resolve(args);
    }
    socket.once(event, onEvent);
    socket.once('connect_error', onError);
  });
}

module.exports = { bootApp, getFreePort, once };
