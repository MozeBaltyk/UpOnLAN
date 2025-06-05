// ../services/docService.js
const fs = require('fs').promises;
const path = require('path');
const marked = require('marked');

const DOCS_DIR = path.resolve('/docs');

// Recursively get all .md files with relative paths
async function listDocs(dir = DOCS_DIR, baseDir = DOCS_DIR) {
  let entries = await fs.readdir(dir, { withFileTypes: true });
  let files = await Promise.all(entries.map(async entry => {
    const res = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return await listDocs(res, baseDir);
    } else if (entry.name.endsWith('.md')) {
      return path.relative(baseDir, res);
    }
    return null;
  }));
  return files.flat()
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

// get the content of .md file
async function getDocContent(filename) {
  const safePath = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.resolve(DOCS_DIR, safePath);
  if (!fullPath.startsWith(DOCS_DIR)) throw new Error('Invalid file path');
  const raw = await fs.readFile(fullPath, 'utf-8');
  return marked.parse(raw);
}

function buildTree(paths) {
  const root = {};

  paths.forEach(filePath => {
    const parts = filePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = part.endsWith('.md');
      const name = part.replace(/\.md$/, '');

      if (i === parts.length - 1) {
        // Leaf node
        current[name] = current[name] || {};
        current[name].__file = isFile ? filePath : null;
      } else {
        current[name] = current[name] || {};
        current = current[name];
      }
    }
  });

  return root;
}

module.exports = {
  listDocs,
  getDocContent,
  buildTree
};