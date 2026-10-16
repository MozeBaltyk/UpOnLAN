// ../sockets/vncProxy.js
'use strict';
const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// Dumb WebSocket <-> TCP pipe that forwards noVNC to QEMU's VNC server on the
// host. The RFB handshake (including VNC auth with the generated password) is
// done end-to-end between noVNC and QEMU; this proxy only bridges the two.
// QEMU's VNC binds the host (0.0.0.0 via the domain XML), reachable from the
// container through the podman bridge gateway.
const VNC_TARGET_HOST = process.env.VNC_TARGET_HOST || 'host.containers.internal';
// libvirt autoport assigns VNC display ports starting at 5900. Restrict the
// proxy to that range so it cannot be used as a general TCP relay to arbitrary
// host ports. Overridable for deployments with a shifted display range.
const VNC_PORT_MIN = Number(process.env.VNC_PORT_MIN) || 5900;
const VNC_PORT_MAX = Number(process.env.VNC_PORT_MAX) || 5999;

function isAllowedVncPort(port) {
  return Number.isInteger(port) && port >= VNC_PORT_MIN && port <= VNC_PORT_MAX;
}

// Short-lived tokens the authenticated socket.io channel mints so noVNC's raw
// WebSocket (which can't carry the Basic auth header) can prove it's allowed.
const VNC_TOKEN_TTL_MS = 60_000;
const vncTokens = new Map(); // token -> { expiry, port }

function purgeExpiredVncTokens(now = Date.now()) {
  for (const [token, value] of vncTokens) if (now >= value.expiry) vncTokens.delete(token);
}

function mintVncToken(port) {
  if (!isAllowedVncPort(port)) throw new Error('Invalid VNC port');
  purgeExpiredVncTokens();
  const token = crypto.randomBytes(16).toString('hex');
  vncTokens.set(token, { expiry: Date.now() + VNC_TOKEN_TTL_MS, port });
  return token;
}

function isValidVncToken(token, port) {
  purgeExpiredVncTokens();
  if (!token || typeof token !== 'string') return false;
  const value = vncTokens.get(token);
  if (!value || value.port !== port) return false;
  vncTokens.delete(token);
  return true;
}

// `authorize(req)` decides whether an upgrade is allowed (mirrors app.js auth).
function attachVncProxy(httpServer, authorize) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/novnc/ws') return; // not ours; let other handlers run

    const port = Number(url.searchParams.get('port'));
    if (!isAllowedVncPort(port)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!authorize(req, port)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = net.connect({ host: VNC_TARGET_HOST, port });
      tcp.on('connect', () => {
        ws.on('message', (data, isBinary) => {
          if (tcp.destroyed) return;
          tcp.write(isBinary ? data : Buffer.from(data));
        });
        tcp.on('data', (chunk) => {
          if (ws.readyState === ws.OPEN) ws.send(chunk);
        });
        ws.on('close', () => tcp.destroy());
        tcp.on('close', () => ws.close());
        tcp.on('error', () => ws.close());
        ws.on('error', () => tcp.destroy());
      });
      tcp.on('error', () => ws.close());
    });
  });

  return wss;
}

module.exports = { attachVncProxy, mintVncToken, isValidVncToken, isAllowedVncPort, purgeExpiredVncTokens };
