// ../services/docService.js
const fs = require('fs').promises;
const path = require('path');
const marked = require('marked');

const DOCS_DIR = path.resolve('/docs');

async function listDocs() {
  const files = await fs.readdir(DOCS_DIR);
  return files
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, '')) // remove .md extension
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));  
}

async function getDocContent(filename) {
  const fullPath = path.join(DOCS_DIR, filename);
  if (!fullPath.startsWith(DOCS_DIR)) throw new Error('Invalid file path');
  const raw = await fs.readFile(fullPath, 'utf-8');
  return marked.parse(raw);
}

module.exports = {
  listDocs,
  getDocContent
};