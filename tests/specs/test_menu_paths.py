"""iPXE menu path vars: boot.cfg asset_path + entries + local-vars + URL resolution."""
import unittest

from tests.specs.helpers import REPO_ROOT, extract


class MenuPathSpecs(unittest.TestCase):
    """The menu must resolve `${mirror_endpoint}${asset_path}<key>/` against
    GitHub (default) and a local nginx mirror (local-vars.ipxe)."""

    def setUp(self):
        self.menus = REPO_ROOT / 'release' / 'menus'

    def test_boot_cfg_defaults_to_github(self):
        cfg = (self.menus / 'boot.cfg').read_text()
        self.assertIn('set mirror_endpoint https://github.com/MozeBaltyk/UpOnLAN', cfg)
        self.assertIn('set asset_path /releases/download/', cfg)

    def test_menu_entries_use_asset_path_var(self):
        for f in ('talos.ipxe', 'harvester.ipxe'):
            content = (self.menus / f).read_text()
            self.assertIn('${mirror_endpoint}${asset_path}', content, f'{f} must use the asset_path var')
            self.assertNotIn('${mirror_endpoint}/releases/download/', content, f'{f} hardcodes the GitHub path')

    def test_local_vars_override(self):
        lv = (self.menus / 'local-vars.ipxe.example').read_text()
        self.assertIn('set mirror_endpoint http://192.168.7.1:8080', lv)
        self.assertIn('set asset_path /', lv)

    def test_menu_url_resolution_local_vs_github(self):
        # Extract the real defaults, then simulate `${mirror_endpoint}${asset_path}<key>/`.
        boot_cfg = (self.menus / 'boot.cfg').read_text()
        local_vars = (self.menus / 'local-vars.ipxe.example').read_text()
        github_mirror = extract(boot_cfg, r'set mirror_endpoint (\S+)')
        github_path = extract(boot_cfg, r'set asset_path (\S+)')
        local_mirror = extract(local_vars, r'set mirror_endpoint (\S+)')
        local_path = extract(local_vars, r'set asset_path (\S+)')

        key = 'talos-v1.13.8-x86_64'
        self.assertEqual(
            f'{github_mirror}{github_path}{key}/',
            'https://github.com/MozeBaltyk/UpOnLAN/releases/download/talos-v1.13.8-x86_64/',
        )
        self.assertEqual(
            f'{local_mirror}{local_path}{key}/',
            'http://192.168.7.1:8080/talos-v1.13.8-x86_64/',
        )


if __name__ == '__main__':
    unittest.main()
