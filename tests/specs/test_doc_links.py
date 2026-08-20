"""Doc link integrity: every `](….md)` link in docs/ + README.md must resolve to
an existing file under the same rules the webapp's doc viewer applies — README
links are repo-root-relative; docs links are docs-root-relative (a leading `../`
is stripped by the server, so a stray `./` that resolves to the docs root rather
than a subfolder is caught as broken)."""
import re
import unittest

from tests.specs.helpers import REPO_ROOT

DOCS_DIR = REPO_ROOT / 'docs'


def _resolve(target, from_readme):
    """Absolute path a link target resolves to, or None if it's not a file link."""
    if target.startswith(('http://', 'https://', '#')):
        return None
    if '#' in target:
        target = target.partition('#')[0]
    if from_readme:
        if target.startswith('docs/'):
            return REPO_ROOT / target
        return DOCS_DIR / target
    norm = re.sub(r'^\./', '', re.sub(r'^(\.\./)+', '', target))
    return DOCS_DIR / norm


class DocLinkSpecs(unittest.TestCase):
    def test_all_markdown_links_resolve(self):
        broken = []
        targets = [REPO_ROOT / 'README.md'] + sorted(DOCS_DIR.rglob('*.md'))
        for f in targets:
            from_readme = f.name == 'README.md'
            text = f.read_text(encoding='utf-8')
            for m in re.finditer(r'\]\(([^)]+\.md)(?:#[^)]*)?\)', text):
                resolved = _resolve(m.group(1), from_readme)
                if resolved is None:
                    continue
                if not resolved.is_file():
                    broken.append(f'{f.relative_to(REPO_ROOT)} -> {m.group(1)}')
        self.assertEqual([], broken)


if __name__ == '__main__':
    unittest.main()
