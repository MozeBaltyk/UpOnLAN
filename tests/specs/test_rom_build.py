"""build_ipxe_roms.sh: static checks of the embed script, artifact mapping, guards.

The full build needs a network fetch + make/gcc/lzma, so these specs validate the
script's deterministic parts (what gets embedded and copied) without building.
"""
import unittest

from tests.specs.helpers import REPO_ROOT


class RomBuildSpecs(unittest.TestCase):
    def setUp(self):
        self.script = (REPO_ROOT / 'scripts' / 'build_ipxe_roms.sh').read_text()

    def test_embed_script_dhcps_then_chains_menu(self):
        # On a fresh option-ROM boot there is no network config, so the embedded
        # script must DHCP before chaining menu.ipxe.
        self.assertIn('dhcp || goto dhcp_failed', self.script)
        self.assertIn('chain --autofree menu.ipxe || goto menu_failed', self.script)
        self.assertIn(':dhcp_failed', self.script)
        self.assertIn(':menu_failed', self.script)

    def test_artifact_mapping(self):
        # build output -> TFTP filename the network advertises.
        for pair in (
            'bin/undionly.kpxe:uponlan.xyz-undionly.kpxe',
            'bin/ipxe.pxe:uponlan.xyz.kpxe',
            'bin-x86_64-efi/ipxe.efi:uponlan.xyz.efi',
            'bin/8086100e.rom:uponlan.xyz-e1000.rom',
        ):
            self.assertIn(pair, self.script)

    def test_requires_lzma(self):
        self.assertIn("command -v lzma", self.script)
        self.assertIn("ERROR: 'lzma' not found", self.script)

    def test_default_ipxe_version(self):
        self.assertIn('IPXE_VERSION="${IPXE_VERSION:-1.21.1}"', self.script)


class BuildReleaseSpecs(unittest.TestCase):
    """build_release.sh runs the pipeline in dependency order and reports the
    menu/ layout path."""

    def setUp(self):
        self.script = (REPO_ROOT / 'scripts' / 'build_release.sh').read_text()

    def test_runs_in_dependency_order(self):
        # ROM build -> assets -> menu, in that order.
        pos_rom = self.script.index('build_ipxe_roms.sh')
        pos_assets = self.script.index('release_assets.sh')
        pos_menu = self.script.index('release_menu.sh')
        self.assertLess(pos_rom, pos_assets)
        self.assertLess(pos_assets, pos_menu)

    def test_reports_menu_layout_path(self):
        self.assertIn('release/output/menu/${VERSION}/menus.tar.gz', self.script)
        self.assertNotIn('release/output/releases/download', self.script)


if __name__ == '__main__':
    unittest.main()
