"""Asset mirror workflow: build.sh layouts + release_assets.sh targeted/untargeted."""
from tests.specs.helpers import TempDirTestCase, STUB_CURL


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


class BuildShLayoutSpecs(TempDirTestCase):
    """build.sh maps MIRROR_LAYOUT to the build dir + endpoints.yml path."""

    def setUp(self):
        super().setUp()
        self.copy('release/assets/build.sh')
        self.stub('bin/curl', STUB_CURL, exe=True)

    def _run_build(self, os_name, output_dir, mirror_layout):
        return self.run_cmd(
            'bash', 'build.sh', os_name,
            cwd='release/assets',
            env={'OUTPUT_DIR': output_dir, 'MIRROR_LAYOUT': mirror_layout, 'NO_RESUME': '1'},
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


class ReleaseAssetsWorkflowSpecs(TempDirTestCase):
    """release_assets.sh: targeted runs are additive, untargeted runs reset."""

    def setUp(self):
        super().setUp()
        self.copy('scripts/release_assets.sh')
        self.copy('release/assets/build.sh')
        self.stub('release/assets/harvester/setting.sh', HARVESTER_SETTING)
        self.stub('release/assets/talos/setting.sh', TALOS_SETTING)
        self.stub('bin/curl', STUB_CURL, exe=True)

    def test_targeted_run_keeps_other_bundles(self):
        self.run_cmd('bash', 'scripts/release_assets.sh', 'harvester')
        self.run_cmd('bash', 'scripts/release_assets.sh', 'talos')
        assets = self.tmp / 'release' / 'output' / 'assets'
        # targeted rebuild of talos must keep harvester
        self.run_cmd('bash', 'scripts/release_assets.sh', 'talos')
        self.assertTrue((assets / 'harvester-v1.7.3-x86_64').exists(), 'targeted run must not wipe other bundles')
        self.assertTrue((assets / 'talos-v1.13.8-x86_64').exists())

    def test_github_layout_passthrough(self):
        # assets.yml relies on release_assets.sh forwarding MIRROR_LAYOUT=github
        # to build.sh (per-bundle /releases/download/<key>/ layout).
        self.run_cmd('bash', 'scripts/release_assets.sh', env={'MIRROR_LAYOUT': 'github'})
        assets = self.tmp / 'release' / 'output' / 'assets'
        self.assertTrue((assets / 'releases' / 'download' / 'harvester-v1.7.3-x86_64' / 'vmlinuz').is_file())
        self.assertIn('path: /releases/download/harvester-v1.7.3-x86_64/', (assets / 'endpoints.yml').read_text())

    def test_untargeted_run_resets_stale_bundles(self):
        self.run_cmd('bash', 'scripts/release_assets.sh', 'harvester')
        self.run_cmd('bash', 'scripts/release_assets.sh', 'talos')
        # simulate removing harvester from the catalog, then a full reset
        (self.tmp / 'release' / 'assets' / 'harvester' / 'setting.sh').unlink()
        self.run_cmd('bash', 'scripts/release_assets.sh')
        assets = self.tmp / 'release' / 'output' / 'assets'
        self.assertFalse((assets / 'harvester-v1.7.3-x86_64').exists(), 'stale bundle must be wiped')
        self.assertTrue((assets / 'talos-v1.13.8-x86_64').exists(), 'remaining bundle rebuilt')


if __name__ == '__main__':
    import unittest
    unittest.main()
