// uponlan.xyz
// Main Node.js app

'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, { path: (process.env.SUBFOLDER || '/') + 'socket.io' });

const baseRoutes = require('./routes/baseRoutes');
const socketHandlers = require('./sockets/socketHandlers');
const { disablesigs } = require('./services/menuServices');

// Disable boot menu signatures
disablesigs();

// --- Authentication --------------------------------------------------------
// Credentials come from WEBAPP_USER / WEBAPP_PASS env vars. If unset, auth is
// disabled with a loud warning (preserves existing unauthenticated deployments;
// production should always set both).
const authUser = process.env.WEBAPP_USER;
const authPass = process.env.WEBAPP_PASS;
const authEnabled = !!(authUser && authPass);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isValidBasic(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return safeEqual(decoded.slice(0, sep), authUser) && safeEqual(decoded.slice(sep + 1), authPass);
}

if (!authEnabled) {
  console.warn('[WARN] Webapp authentication disabled. Set WEBAPP_USER and WEBAPP_PASS env vars.');
}

// Gate all HTTP routes (page, static, rendered JS). Note: engine.io intercepts
// the socket.io path on the http server before Express, so the socket.io
// handshake (polling AND websocket) is gated by the io.use middleware below.
app.use((req, res, next) => {
  if (authEnabled && !isValidBasic(req.headers.authorization)) {
    res.set('WWW-Authenticate', 'Basic realm="UpOnLAN"');
    res.status(401).send('Authentication required');
    return;
  }
  next();
});

// Gate WebSocket upgrade path, which bypasses Express middleware
if (authEnabled) {
  io.use((socket, next) => {
    if (isValidBasic(socket.handshake.headers.authorization) ||
        (socket.handshake.auth && safeEqual(socket.handshake.auth.token, authPass))) {
      next();
    } else {
      next(new Error('unauthorized'));
    }
  });
}

// Set up EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use((process.env.SUBFOLDER || '/') + 'public', express.static(path.join(__dirname, 'public')));

// Register routes
app.use(process.env.SUBFOLDER || '/', baseRoutes);

// Register socket.io handlers
socketHandlers(io);

// Export components so tests can boot the server on their own port.
module.exports = { app, http, io };

// Start server (only when run directly: `node app.js`)
if (require.main === module) {
  const port = Number(process.env.WEB_APP_PORT) || 3000;
  http.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
  });
}