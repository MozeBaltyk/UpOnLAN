// Unit tests: doc tree building (pure) and the path-traversal guard on
// doc reads (throws before touching the filesystem).
import { describe, expect, it } from 'vitest';
import { buildTree, getDocContent } from '../../services/docServices.js';

describe('docServices.buildTree', () => {
  it('builds a nested tree from relative paths', () => {
    const tree = buildTree(['index.md', 'guides/advanced.md', 'guides/basics/getting-started.md']);
    expect(tree.index.__file).toBe('index.md');
    expect(tree.guides.advanced.__file).toBe('guides/advanced.md');
    expect(tree.guides.basics['getting-started'].__file).toBe('guides/basics/getting-started.md');
  });

  it('returns an empty tree for no docs', () => {
    expect(buildTree([])).toEqual({});
  });
});

describe('docServices.getDocContent traversal guard', () => {
  it('sanitizes ../ prefixes so reads stay inside the docs root', async () => {
    // '../etc/passwd' is sanitized to 'etc/passwd' under /docs -> ENOENT,
    // never /etc/passwd. The security property: no input escapes the root.
    await expect(getDocContent('../etc/passwd')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(getDocContent('../../../../etc/passwd')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(getDocContent('foo/../../etc/passwd')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects absolute paths outside the docs root', async () => {
    await expect(getDocContent('/etc/passwd')).rejects.toThrow('Invalid file path');
  });
});
