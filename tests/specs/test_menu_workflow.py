"""Menu release workflow: release_menu.sh warn/exclude + menu.ipxe labels."""
import re
import tarfile
import unittest

from tests.specs.helpers import REPO_ROOT, TempDirTestCase


class ReleaseMenuWorkflowSpecs(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.copy('scripts/release_menu.sh')
        self.stub('release/menus/version.ipxe', '#!ipxe\nset menu_version 0.0.1\n')
        self.stub('release/menus/menu.ipxe', '#!ipxe\n:start\nexit\n')
        self.stub('release/menus/boot.cfg', '#!ipxe\n')

    def test_warns_but_proceeds_without_rom_artifacts(self):
        # No rom/ipxe artifacts -> release_menu.sh warns but still ships the menu.
        proc = self.run_cmd('bash', 'scripts/release_menu.sh', '0.0.2', check=False)
        self.assertEqual(proc.returncode, 0)
        self.assertIn('iPXE artifact missing', proc.stdout + proc.stderr)
        tarball = self.tmp / 'release' / 'output' / 'menu' / '0.0.2' / 'menus.tar.gz'
        self.assertTrue(tarball.is_file(), 'menus.tar.gz not produced without ROM artifacts')

    def test_excludes_local_vars_from_tarball(self):
        self.stub_rom_artifacts()
        self.stub('release/menus/local-vars.ipxe', 'set mirror_endpoint http://192.168.7.1:8080\n')
        self.run_cmd('bash', 'scripts/release_menu.sh', '0.0.2')
        tarball = self.tmp / 'release' / 'output' / 'menu' / '0.0.2' / 'menus.tar.gz'
        with tarfile.open(tarball) as tf:
            names = tf.getnames()
        self.assertNotIn('./local-vars.ipxe', names)
        self.assertIn('./menu.ipxe', names)


class MenuLabelsSpecs(unittest.TestCase):
    """Every `item <label>` in menu.ipxe must resolve to a `:<label>` handler."""

    def test_menu_items_resolve_to_labels(self):
        content = (REPO_ROOT / 'release' / 'menus' / 'menu.ipxe').read_text()
        labels = set(re.findall(r'^:\s*(\S+)', content, re.MULTILINE))
        for m in re.finditer(r'\bitem\s+(\S+)', content):
            label = m.group(1)
            if label == '--gap':
                continue
            self.assertIn(label, labels, f'menu.ipxe item "{label}" has no :{label} handler')


if __name__ == '__main__':
    unittest.main()
