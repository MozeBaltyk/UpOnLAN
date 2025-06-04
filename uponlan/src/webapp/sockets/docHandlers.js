// ../sockets/docHandlers.js
const { listDocs, getDocContent } = require('../services/docService');

module.exports = function(socket) {
  socket.on('docs:list', async () => {
    try {
      const docs = await listDocs();
      // Strip .md extensions
      const cleanNames = docs.map(f => f.replace(/\.md$/, ''));
      socket.emit('docs:list:response', cleanNames);
    } catch (err) {
      console.error(err);
      socket.emit('error', 'Failed to list docs');
    }
  });

  socket.on('docs:get', async (filename) => {
    try {
      // Append .md if not present
      const content = await getDocContent(filename.endsWith('.md') ? filename : `${filename}.md`);
      socket.emit('docs:get:response', { filename, content });
    } catch (err) {
      console.error(err);
      socket.emit('error', 'Failed to read doc');
    }
  });
};