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
        ):
            self.assertIn(pair, self.script)

    def test_requires_lzma(self):
        self.assertIn("command -v lzma", self.script)
        self.assertIn("ERROR: 'lzma' not found", self.script)

    def test_default_ipxe_version(self):
        self.assertIn('IPXE_VERSION="${IPXE_VERSION:-1.21.1}"', self.script)

    def test_vendored_source_fallback(self):
        # Prefer a vendored tarball (offline) at /opt/ipxe/ipxe-<ver>.tar.gz,
        # falling back to a GitHub fetch only when it's absent.
        self.assertIn('IPXE_TARBALL="${IPXE_TARBALL:-/opt/ipxe/ipxe-${IPXE_VERSION}.tar.gz}"', self.script)
        self.assertIn('using vendored iPXE source', self.script)
        self.assertIn('fetching iPXE v$IPXE_VERSION', self.script)
        self.assertIn('cp "$IPXE_TARBALL" "$WORK/ipxe.tar.gz"', self.script)

    def test_optional_https_trust_knobs(self):
        # TRUST/CERT are optional and off by default; when set they must be
        # passed to make and validated to exist.
        self.assertIn('for v in TRUST CERT; do', self.script)
        self.assertIn('ERROR: $v file not found', self.script)
        self.assertIn('$SSL_ARGS', self.script)
        self.assertIn('bios_targets EMBED="$WORK/embed.ipxe"', self.script)

    def test_enables_https_download_protocol(self):
        # iPXE defaults to `#undef DOWNLOAD_PROTO_HTTPS`; without it https:// URLs
        # fail with "Operation not supported". The build must define it via a
        # config/local/general.h override.
        self.assertIn('config/local/general.h', self.script)
        self.assertIn('#define DOWNLOAD_PROTO_HTTPS', self.script)

    def test_no_e1000_host_option_rom(self):
        # BIOS VM support was removed: no e1000 PCI option ROM target or host
        # install/sync logic remains.
        self.assertNotIn('8086100e.rom', self.script)
        self.assertNotIn('uponlan-e1000.rom', self.script)
        self.assertNotIn('PXE_ROM_PATH', self.script)

    def test_stages_serializes_and_publishes_manifest_last(self):
        self.assertIn('.ipxe-stage-', self.script)
        self.assertIn('flock 9', self.script)
        self.assertIn("'{schemaVersion:1,ipxeVersion:$version,builtAt:$builtAt", self.script)
        self.assertLess(self.script.index('rm -f "$OUT_ROM/build-manifest.json"'), self.script.index('mv "$STAGE/build-manifest.json"'))
        self.assertGreater(self.script.index('mv "$STAGE/build-manifest.json"'), self.script.index('for file in "$STAGE"/uponlan.xyz.*'))


class BuildReleaseSpecs(unittest.TestCase):
    """build_release.sh runs the local release pipeline (assets -> menu) and
    deliberately does NOT build iPXE ROMs (those embed the TLS cert at deploy
    time)."""

    def setUp(self):
        self.script = (REPO_ROOT / 'scripts' / 'build_release.sh').read_text()

    def test_assets_before_menu_and_no_rom_build(self):
        # assets -> menu, in that order; no ROM build here.
        self.assertNotIn('build_ipxe_roms.sh', self.script)
        pos_assets = self.script.index('release_assets.sh')
        pos_menu = self.script.index('release_menu.sh')
        self.assertLess(pos_assets, pos_menu)

    def test_reports_menu_layout_path(self):
        self.assertIn('release/output/menu/${MENU_VERSION}/menus.tar.gz', self.script)
        self.assertNotIn('release/output/releases/download', self.script)


class InitRomFreshnessSpecs(unittest.TestCase):
    def test_generated_certificate_records_public_provenance_without_key_material(self):
        init = (REPO_ROOT / 'src' / 'init.sh').read_text()
        self.assertIn('TLS_DEFAULT_MARKER=/config/tls/.uponlan-default-cert.sha256', init)
        self.assertIn('sha256sum "$TLS_CRT"', init)
        self.assertNotIn('sha256sum "$TLS_KEY"', init)

    def test_rebuild_requires_complete_manifest_and_current_trust_hash(self):
        init = (REPO_ROOT / 'src' / 'init.sh').read_text()
        self.assertIn('roms_current()', init)
        self.assertIn('build-manifest.json', init)
        self.assertIn('.ipxeVersion == "1.21.1"', init)
        self.assertIn('.trustSha256 == $trust', init)
        self.assertIn('length == 8', init)
        self.assertIn('sha256sum "$dir/$name"', init)
        self.assertIn('if ! roms_current; then', init)


if __name__ == '__main__':
    unittest.main()
