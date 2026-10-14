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
        self.assertIn('set local_endpoint https://192.168.7.1:8443/', cfg)

    def test_menu_entries_use_local_endpoint_var(self):
        for f in ('talos.ipxe', 'harvester.ipxe', 'rockylinux.ipxe', 'proxmox.ipxe', 'ubuntu.ipxe'):
            content = (self.menus / f).read_text()
            self.assertIn('${local_endpoint}', content, f'{f} must use the local_endpoint var')
            self.assertNotIn('${mirror_endpoint}${asset_path}', content, f'{f} still chains the GitHub origin')

    def test_rocky_and_ubuntu_ship_canned_provisioning_urls(self):
        rocky = (self.menus / 'rockylinux.ipxe').read_text()
        ubuntu = (self.menus / 'ubuntu.ipxe').read_text()
        self.assertIn('item kickstart_example', rocky)
        self.assertIn('inst.ks=${kickstart_url}', rocky)
        self.assertIn('Specify kickstart URL', rocky)
        self.assertIn('item automated_example', ubuntu)
        self.assertIn('autoinstall ds=nocloud-net;s=${cloud_init_url}', ubuntu)
        self.assertIn('Specify preseed/autoinstall url', ubuntu)
        self.assertNotIn('md5sum', rocky)
        self.assertNotIn('md5sum', ubuntu)

    def test_boot_cfg_defines_provisioning_url_defaults(self):
        cfg = (self.menus / 'boot.cfg').read_text()
        self.assertIn('isset ${kickstart_url} || set kickstart_url ${local_endpoint}provisioning/kickstart/example/ks.cfg', cfg)
        self.assertIn('isset ${cloud_init_url} || set cloud_init_url ${local_endpoint}provisioning/cloud-init/example/', cfg)

    def test_local_vars_override(self):
        lv = (self.menus / 'local-vars.ipxe.example').read_text()
        self.assertIn('set local_endpoint https://192.168.7.1:8443/', lv)
        self.assertIn('kickstart_url', lv)
        self.assertIn('cloud_init_url', lv)

    def test_top_level_okd_entry_only_chains_the_managed_local_menu(self):
        menu = (self.menus / 'menu.ipxe').read_text()
        self.assertIn('item okd ${space} OKD Agent Installer', menu)
        handler = menu.split(':okd\n', 1)[1].split('\n:', 1)[0].strip()
        self.assertEqual(handler, 'chain local/okd.ipxe || goto error\ngoto main_menu')

    def test_local_action_confirms_firmware_exit_without_guessing_disks(self):
        menu = (self.menus / 'menu.ipxe').read_text()
        local = menu.split(':local\n', 1)[1].split('\n:', 1)[0]
        self.assertIn('Exit to firmware', menu)
        self.assertIn('prompt --key 0x79', local)
        self.assertIn('|| goto main_menu', local)
        self.assertTrue(local.rstrip().endswith('exit'))
        self.assertNotIn('sanboot', local)
        self.assertNotIn('No local disk', local)
        self.assertIn('--default stay', menu)
        embed = (REPO_ROOT / 'scripts/build_ipxe_roms.sh').read_text()
        self.assertIn('chain --autofree menu.ipxe || goto menu_failed\nexit', embed)

    def test_okd_assets_disable_listing_without_changing_generic_download_root(self):
        nginx = (REPO_ROOT / 'src/defaults/default').read_text()
        location = nginx.split('location ^~ /okd/ {', 1)[1].split('}', 1)[0]
        self.assertIn('root /assets;', location)
        self.assertIn('autoindex off;', location)
        self.assertNotIn('deny all', location)
        self.assertIn('location / {\n\t\troot /assets;\n\t\tautoindex on;', nginx)
        webapp = nginx.split('proxy_pass http://127.0.0.1:${WEB_APP_PORT};', 1)[1]
        self.assertIn('client_max_body_size 7m;', webapp)

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
            'https://192.168.7.1:8443/talos-v1.13.8-x86_64/',
        )


if __name__ == '__main__':
    import unittest
    unittest.main()
