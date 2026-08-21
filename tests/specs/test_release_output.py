"""release/output layout: menu/ + assets/ split, no legacy releases/ namespace."""
from tests.specs.helpers import REPO_ROOT, TempDirTestCase, STUB_CURL


class ReleaseOutputSpecs(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.copy('scripts/release_assets.sh')
        self.copy('scripts/release_menu.sh')
        self.copy('release/assets/build.sh')

        self.stub(
            'release/assets/harvester/setting.sh',
            '''\
            OS=harvester
            VERSION=v1.7.3
            ARCHS=amd64
            BUILD_TYPE=direct_file
            EXTRACTS="http://example.com/vmlinuz|vmlinuz"
            ''',
        )
        self.stub('release/menus/version.ipxe', '#!ipxe\nset menu_version 0.0.1\n')
        self.stub('release/menus/menu.ipxe', '#!ipxe\n:start\nexit\n')
        self.stub('release/menus/boot.cfg', '#!ipxe\n')
        self.stub_rom_artifacts()
        self.stub('bin/curl', STUB_CURL, exe=True)

    def test_release_assets_builds_assets_layout(self):
        self.run_cmd('bash', 'scripts/release_assets.sh')
        assets = self.tmp / 'release' / 'output' / 'assets'
        self.assertTrue((assets / 'endpoints.yml').is_file(), 'assets/endpoints.yml missing')
        yml = (assets / 'endpoints.yml').read_text()
        self.assertIn('path: /assets/harvester-v1.7.3-x86_64/', yml)
        # direct_file is catalog-only: metadata + vendor sources, no bundle dir.
        self.assertIn('build_type: direct_file', yml)
        self.assertIn('- http://example.com/vmlinuz', yml)
        self.assertFalse((assets / 'harvester-v1.7.3-x86_64').exists(), 'direct_file must not download a bundle')

    def test_release_menu_builds_menu_layout(self):
        self.run_cmd('bash', 'scripts/release_menu.sh', '0.0.2')
        menu = self.tmp / 'release' / 'output' / 'menu'
        self.assertEqual('{"tag_name":"0.0.2"}', (menu / 'latest').read_text().strip())
        self.assertTrue((menu / '0.0.2' / 'menus.tar.gz').is_file(), 'menus.tar.gz missing')
        self.assertIn('set menu_version 0.0.2', (self.tmp / 'release' / 'menus' / 'version.ipxe').read_text())

    def test_release_assets_does_not_clobber_menu(self):
        self.run_cmd('bash', 'scripts/release_menu.sh', '0.0.2')
        self.run_cmd('bash', 'scripts/release_assets.sh')
        # assets is a sibling of menu/, so an untargeted reset must leave menu/ intact.
        self.assertTrue((self.tmp / 'release' / 'output' / 'menu' / 'latest').is_file())
        self.assertTrue((self.tmp / 'release' / 'output' / 'menu' / '0.0.2' / 'menus.tar.gz').is_file())

    def test_no_legacy_releases_namespace(self):
        self.run_cmd('bash', 'scripts/release_assets.sh')
        self.run_cmd('bash', 'scripts/release_menu.sh', '0.0.2')
        self.assertFalse((self.tmp / 'release' / 'output' / 'releases').exists(), 'legacy releases/ dir present')
        self.assertFalse((self.tmp / 'release' / 'output' / 'endpoints.yml').exists(), 'endpoints.yml at root (old layout)')


if __name__ == '__main__':
    import unittest
    unittest.main()
