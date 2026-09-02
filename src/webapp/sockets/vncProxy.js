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

// Short-lived tokens the authenticated socket.io channel mints so noVNC's raw
// WebSocket (which can't carry the Basic auth header) can prove it's allowed.
const VNC_TOKEN_TTL_MS = 60_000;
const vncTokens = new Map(); // token -> expiry epoch ms

function mintVncToken() {
  const token = crypto.randomBytes(16).toString('hex');
  vncTokens.set(token, Date.now() + VNC_TOKEN_TTL_MS);
  return token;
}

function isValidVncToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expiry = vncTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { vncTokens.delete(token); return false; }
  return true;
}

// `authorize(req)` decides whether an upgrade is allowed (mirrors app.js auth).
function attachVncProxy(httpServer, authorize) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/novnc/ws') return; // not ours; let other handlers run

    if (!authorize(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const port = Number(url.searchParams.get('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
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

module.exports = { attachVncProxy, mintVncToken, isValidVncToken };

