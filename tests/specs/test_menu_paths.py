"""iPXE menu path vars: boot.cfg origins + entries + local-vars + URL resolution."""
import unittest

from tests.specs.helpers import REPO_ROOT, extract


class MenuPathSpecs(unittest.TestCase):
    """direct_file menus chain ${local_endpoint}<key>/ (local nginx); the
    GitHub origin ${mirror_endpoint}${asset_path} remains for iso_extraction."""

    def setUp(self):
        self.menus = REPO_ROOT / 'release' / 'menus'

    def test_boot_cfg_defines_origins(self):
        cfg = (self.menus / 'boot.cfg').read_text()
        # GitHub origin (iso_extraction) + local nginx origin (direct_file).
        self.assertIn('set mirror_endpoint https://github.com/MozeBaltyk/UpOnLAN', cfg)
        self.assertIn('set asset_path /releases/download/', cfg)
        self.assertIn('set local_endpoint http://192.168.7.1:8080/', cfg)

    def test_menu_entries_use_local_endpoint_var(self):
        for f in ('talos.ipxe', 'harvester.ipxe', 'rockylinux.ipxe', 'proxmox.ipxe', 'ubuntu.ipxe'):
            content = (self.menus / f).read_text()
            self.assertIn('${local_endpoint}', content, f'{f} must use the local_endpoint var')
            self.assertNotIn('${mirror_endpoint}${asset_path}', content, f'{f} still chains the GitHub origin')

    def test_local_vars_override(self):
        lv = (self.menus / 'local-vars.ipxe.example').read_text()
        self.assertIn('set local_endpoint http://192.168.7.1:8080/', lv)

    def test_menu_url_resolution_local_vs_github(self):
        # Extract the real defaults, then simulate the two origin layouts.
        boot_cfg = (self.menus / 'boot.cfg').read_text()
        local_vars = (self.menus / 'local-vars.ipxe.example').read_text()
        github_mirror = extract(boot_cfg, r'set mirror_endpoint (\S+)')
        github_path = extract(boot_cfg, r'set asset_path (\S+)')
        local_endpoint = extract(local_vars, r'set local_endpoint (\S+)')

        key = 'talos-v1.13.8-x86_64'
        # iso_extraction: GitHub release layout.
        self.assertEqual(
            f'{github_mirror}{github_path}{key}/',
            'https://github.com/MozeBaltyk/UpOnLAN/releases/download/talos-v1.13.8-x86_64/',
        )
        # direct_file: local nginx origin (already carries the trailing slash).
        self.assertEqual(
            f'{local_endpoint}{key}/',
            'http://192.168.7.1:8080/talos-v1.13.8-x86_64/',
        )


if __name__ == '__main__':
    import unittest
    unittest.main()
