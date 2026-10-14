import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { buildTree, listDocs } from '../../services/docServices.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const docsRoot = path.join(root, 'docs');

describe('documentation navigation', () => {
  it('renders Kubernetes last without reordering other categories or nested pages', async () => {
    const files = await listDocs(docsRoot, docsRoot);
    const tree = buildTree(files);
    const originalOrder = [...new Set(files.map((file) => file.split('/')[0]
      .replace(/\.md$/, '').replace(/^\d{2}-/, '')))];
    expect(Object.keys(tree)).toEqual([
      ...originalOrder.filter((key) => key !== 'Kubernetes'), 'Kubernetes',
    ]);
    expect(Object.keys(tree.Kubernetes.OKD)).toEqual(files
      .filter((file) => file.startsWith('Kubernetes/OKD/'))
      .map((file) => path.basename(file, '.md').replace(/^\d{2}-/, '')));

    // Execute the actual browser TOC renderer, including JSON socket transport.
    const view = await fs.readFile(path.join(root, 'src/webapp/views/uponlanxyz-web.ejs'), 'utf8');
    const start = view.indexOf('function prettyLabel(');
    const end = view.indexOf('function renderdoc()', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const html = vm.runInNewContext(`${view.slice(start, end)}\nrenderTree(tree)`, {
      tree: JSON.parse(JSON.stringify(tree)),
    });
    const folders = [...html.matchAll(/data-target="#doc-folder-([^"]+)"/g)]
      .map((match) => match[1]);
    expect(folders.indexOf('Kubernetes')).toBeGreaterThan(folders.indexOf('UpOnLAN-xyz'));
    expect(folders.indexOf('Kubernetes')).toBeGreaterThan(folders.indexOf('iPXE'));
    expect(html.indexOf('data-doc="Kubernetes/OKD/01-Prerequisites.md"'))
      .toBeLessThan(html.indexOf('data-doc="Kubernetes/OKD/08-Troubleshooting.md"'));
  });

  it('keeps project-relative Markdown navigation targets valid and removes Talos doc links', async () => {
    const files = await listDocs(docsRoot, docsRoot);
    const known = new Set(files.map((file) => path.join(docsRoot, file)));
    const sources = [...known, path.join(root, 'README.md')];
    const broken = [];
    for (const source of sources) {
      const raw = await fs.readFile(source, 'utf8');
      marked.walkTokens(marked.lexer(raw), (token) => {
        if (token.type !== 'link') return;
        const href = decodeURIComponent(token.href.split('#')[0]);
        expect(href).not.toMatch(/Kubernetes\/Talos\//i);
        if (!href.endsWith('.md') || /^(?:[a-z]+:|\/\/)/i.test(href)) return;
        const target = source === path.join(root, 'README.md') && href.startsWith('docs/')
          ? path.resolve(root, href)
          : path.resolve(docsRoot, href.replace(/^(\.\.\/)+/, '').replace(/^\.\//, ''));
        if (!known.has(target)) {
          broken.push(`${path.relative(root, source)} → ${href}`);
        }
      });
    }
    expect(broken).toEqual([]);
    expect(files.some((file) => file.startsWith('Kubernetes/Talos/'))).toBe(false);
  });
});
