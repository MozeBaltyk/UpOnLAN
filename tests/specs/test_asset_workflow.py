"""Asset mirror workflow: build.sh layouts + release_assets.sh targeted/untargeted."""
from tests.specs.helpers import TempDirTestCase, STUB_CURL, STUB_7Z


HARVESTER_SETTING = '''\
OS=harvester
VERSION=v1.7.3
ARCHS=amd64
BUILD_TYPE=direct_file
EXTRACTS="http://example.com/vmlinuz|vmlinuz"
'''

TALOS_SETTING = '''\
OS=talos
VERSION=v1.13.8
ARCHS=amd64,aarch64
BUILD_TYPE=direct_file
EXTRACTS="http://example.com/vmlinuz|vmlinuz
http://example.com/initrd|initrd"
'''

# REPLACE_ARCH exercises the arch substitution that lands in `sources`.
ROCKY_SETTING = '''\
OS=rocky
VERSION=9
ARCHS=amd64,aarch64
BUILD_TYPE=direct_file
EXTRACTS="http://example.com/rocky/REPLACE_ARCH/vmlinuz|vmlinuz"
'''

ISO_SETTING = '''\
OS=oracle
VERSION=8
ARCHS=amd64
BUILD_TYPE=iso_extraction
URL=http://example.com/oracle.iso
EXTRACTS="images/pxeboot/vmlinuz|vmlinuz
images/pxeboot/initrd|initrd"
'''


class BuildShLayoutSpecs(TempDirTestCase):
    """build.sh maps MIRROR_LAYOUT to the build dir + endpoints.yml path."""

    def setUp(self):
        super().setUp()
        self.copy('release/assets/build.sh')
        self.stub('bin/curl', STUB_CURL, exe=True)

    def _run_build(self, os_name, output_dir, mirror_layout, extra_env=None):
        env = {'OUTPUT_DIR': output_dir, 'MIRROR_LAYOUT': mirror_layout, 'NO_RESUME': '1'}
        if extra_env:
            env.update(extra_env)
        return self.run_cmd(
            'bash', 'build.sh', os_name,
            cwd='release/assets',
            env=env,
        )

    def test_github_layout(self):
        self.stub('release/assets/harvester/setting.sh', HARVESTER_SETTING)
        self._run_build('harvester', '../output', 'github')
        out = self.tmp / 'release' / 'output'
        self.assertTrue((out / 'releases' / 'download' / 'harvester-v1.7.3-x86_64' / 'vmlinuz').is_file())
        self.assertIn('path: /releases/download/harvester-v1.7.3-x86_64/', (out / 'endpoints.yml').read_text())

    def test_local_layout(self):
        self.stub('release/assets/talos/setting.sh', TALOS_SETTING)
        self._run_build('talos', '../output/assets', 'local')
        out = self.tmp / 'release' / 'output' / 'assets'
        self.assertTrue((out / 'talos-v1.13.8-x86_64' / 'vmlinuz').is_file())
        self.assertTrue((out / 'talos-v1.13.8-arm64' / 'vmlinuz').is_file())
        yml = (out / 'endpoints.yml').read_text()
        self.assertIn('path: /assets/talos-v1.13.8-x86_64/', yml)
        self.assertIn('path: /assets/talos-v1.13.8-arm64/', yml)

    def test_arch_mapping_and_files_array(self):
        self.stub('release/assets/talos/setting.sh', TALOS_SETTING)
        self._run_build('talos', '../output/assets', 'local')
        yml = (self.tmp / 'release' / 'output' / 'assets' / 'endpoints.yml').read_text()
        # amd64 -> x86_64, aarch64 -> arm64
        self.assertIn('arch: x86_64', yml)
        self.assertIn('arch: arm64', yml)
        # files list derived from EXTRACTS (two entries)
        self.assertIn('- vmlinuz', yml)
        self.assertIn('- initrd', yml)

    def test_catalog_only_writes_catalog_without_downloading(self):
        self.stub('release/assets/talos/setting.sh', TALOS_SETTING)
        self._run_build('talos', '../output/assets', 'local', extra_env={'CATALOG_ONLY': '1'})
        out = self.tmp / 'release' / 'output' / 'assets'
        yml = (out / 'endpoints.yml').read_text()
        # Catalog entry written with build_type + vendor sources...
        self.assertIn('build_type: direct_file', yml)
        self.assertIn('- http://example.com/vmlinuz', yml)
        self.assertIn('path: /assets/talos-v1.13.8-x86_64/', yml)
        # ...but no files were downloaded.
        self.assertFalse((out / 'talos-v1.13.8-x86_64').exists())
        self.assertFalse((out / 'talos-v1.13.8-arm64').exists())

    def test_sources_are_arch_substituted(self):
        self.stub('release/assets/rocky/setting.sh', ROCKY_SETTING)
        self._run_build('rocky', '../output/assets', 'local')
        yml = (self.tmp / 'release' / 'output' / 'assets' / 'endpoints.yml').read_text()
        # REPLACE_ARCH -> raw arch (amd64/aarch64) in the vendor sources.
        self.assertIn('- http://example.com/rocky/amd64/vmlinuz', yml)
        self.assertIn('- http://example.com/rocky/aarch64/vmlinuz', yml)
        self.assertIn('build_type: direct_file', yml)


class ReleaseAssetsWorkflowSpecs(TempDirTestCase):
    """release_assets.sh: direct_file is catalog-only + skipped on GitHub,
    iso_extraction still builds; targeted runs are additive, untargeted reset."""

    def setUp(self):
        super().setUp()
        self.copy('scripts/release_assets.sh')
        self.copy('release/assets/build.sh')
        self.stub('release/assets/harvester/setting.sh', HARVESTER_SETTING)
        self.stub('release/assets/talos/setting.sh', TALOS_SETTING)
        self.stub('release/assets/oracle/setting.sh', ISO_SETTING)
        self.stub('bin/curl', STUB_CURL, exe=True)
        self.stub('bin/7z', STUB_7Z, exe=True)

    def test_targeted_run_keeps_other_catalog_entries(self):
        self.run_cmd('bash', 'scripts/release_assets.sh', 'harvester')
        self.run_cmd('bash', 'scripts/release_assets.sh', 'talos')
        # targeted rebuild of talos must keep harvester's catalog entry
        self.run_cmd('bash', 'scripts/release_assets.sh', 'talos')
        yml = (self.tmp / 'release' / 'output' / 'assets' / 'endpoints.yml').read_text()
        self.assertIn('harvester-v1.7.3-x86_64', yml, 'targeted run must not wipe other catalog entries')
        self.assertIn('talos-v1.13.8-x86_64', yml)

    def test_github_layout_passthrough(self):
        # assets.yml relies on release_assets.sh forwarding MIRROR_LAYOUT=github:
        # iso_extraction still builds to the per-bundle /releases/download/<key>/
        # layout, while direct_file contributes catalog entries only (local
        # /assets/<key>/ path + vendor sources, no GitHub bundle).
        self.run_cmd('bash', 'scripts/release_assets.sh', env={'MIRROR_LAYOUT': 'github'})
        assets = self.tmp / 'release' / 'output' / 'assets'
        self.assertTrue((assets / 'releases' / 'download' / 'oracle-8-x86_64' / 'vmlinuz').is_file())
        yml = (assets / 'endpoints.yml').read_text()
        self.assertIn('path: /releases/download/oracle-8-x86_64/', yml)
        self.assertIn('build_type: iso_extraction', yml)
        self.assertIn('path: /assets/harvester-v1.7.3-x86_64/', yml)
        self.assertIn('path: /assets/talos-v1.13.8-x86_64/', yml)
        self.assertIn('build_type: direct_file', yml)
        self.assertFalse((assets / 'releases' / 'download' / 'harvester-v1.7.3-x86_64').exists())
        self.assertFalse((assets / 'releases' / 'download' / 'talos-v1.13.8-x86_64').exists())

    def test_direct_file_github_is_catalog_only(self):
        # direct_file recipes publish catalog entries (for on-demand import) but
        # never a GitHub bundle.
        self.run_cmd('bash', 'scripts/release_assets.sh', 'harvester', env={'MIRROR_LAYOUT': 'github'})
        assets = self.tmp / 'release' / 'output' / 'assets'
        self.assertFalse((assets / 'releases' / 'download' / 'harvester-v1.7.3-x86_64').exists())
        yml = (assets / 'endpoints.yml').read_text()
        self.assertIn('path: /assets/harvester-v1.7.3-x86_64/', yml)
        self.assertIn('- http://example.com/vmlinuz', yml)

    def test_local_catalog_only_direct_file(self):
        # default (local) layout: direct_file is catalog-only, no downloads.
        self.run_cmd('bash', 'scripts/release_assets.sh', 'harvester')
        assets = self.tmp / 'release' / 'output' / 'assets'
        yml = (assets / 'endpoints.yml').read_text()
        self.assertIn('build_type: direct_file', yml)
        self.assertIn('- http://example.com/vmlinuz', yml)
        self.assertFalse((assets / 'harvester-v1.7.3-x86_64').exists(), 'direct_file must not download')

    def test_untargeted_run_resets_stale_catalog_entries(self):
        self.run_cmd('bash', 'scripts/release_assets.sh', 'harvester')
        self.run_cmd('bash', 'scripts/release_assets.sh', 'talos')
        # simulate removing harvester from the catalog, then a full reset
        (self.tmp / 'release' / 'assets' / 'harvester' / 'setting.sh').unlink()
        self.run_cmd('bash', 'scripts/release_assets.sh')
        yml = (self.tmp / 'release' / 'output' / 'assets' / 'endpoints.yml').read_text()
        self.assertNotIn('harvester-v1.7.3-x86_64', yml, 'stale entry must be wiped')
        self.assertIn('talos-v1.13.8-x86_64', yml, 'remaining entry rebuilt')


if __name__ == '__main__':
    import unittest
    unittest.main()
