// uponlan.xyz
// Main Node.js app

const path = require('path');
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, { path: (process.env.SUBFOLDER || '/') + 'socket.io' });

const baseRoutes = require('./routes/baseRoutes');
const socketHandlers = require('./sockets/socketHandlers');
const { disablesigs } = require('./services/menuServices');

// Disable boot menu signatures
disablesigs();

// Set up EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use((process.env.SUBFOLDER || '/') + 'public', express.static(path.join(__dirname, 'public')));

// Register routes
app.use(process.env.SUBFOLDER || '/', baseRoutes);

// Register socket.io handlers
socketHandlers(io);

// Start server
const port = Number(process.env.WEB_APP_PORT) || 3000;
http.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
