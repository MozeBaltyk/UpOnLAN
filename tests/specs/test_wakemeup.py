"""wakemeup.sh CLI: deploy --local gates + mirror-assets asset_target forwarding."""
import unittest

from tests.specs.helpers import TempDirTestCase, STUB_SUDO, STUB_PYTHON3


class DeployLocalSpecs(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.copy('wakemeup.sh')
        self.stub('bin/sudo', STUB_SUDO, exe=True)
        self.stub('bin/python3', STUB_PYTHON3, exe=True)
        # deploy renders the Helm chart and pipes it to `podman play kube -`;
        # sudo is stubbed so the play is a no-op, and helm is stubbed here too.
        self.stub('bin/helm', '#!/bin/bash\nexit 0\n', exe=True)
        self.stub('release/menus/version.ipxe', '#!ipxe\nset menu_version 0.1.0\n')

    def test_requires_assets_endpoints(self):
        self.stub('release/output/menu/0.1.0/menus.tar.gz', 'menu')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local', check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('assets/endpoints.yml', proc.stdout + proc.stderr)

    def test_requires_menu_tarball(self):
        self.stub('release/output/assets/endpoints.yml', 'endpoints: {}\n')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local', check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('menu/0.1.0/menus.tar.gz', proc.stdout + proc.stderr)

    def test_deploys_when_both_present(self):
        self.stub('release/output/assets/endpoints.yml', 'endpoints: {}\n')
        self.stub('release/output/menu/0.1.0/menus.tar.gz', 'menu')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local')
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_build_flag_is_accepted(self):
        # --build (with --local) builds the local image and serves local assets;
        # with sudo/helm stubbed the whole path should still complete.
        self.stub('release/output/assets/endpoints.yml', 'endpoints: {}\n')
        self.stub('release/output/menu/0.1.0/menus.tar.gz', 'menu')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local', '--build')
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class MirrorAssetsSpecs(TempDirTestCase):
    """mirror-assets forwards asset_target=<os> to release_assets.sh."""

    def setUp(self):
        super().setUp()
        self.copy('wakemeup.sh')
        # Stub release_assets.sh to record the positional arg it receives.
        self.stub(
            'scripts/release_assets.sh',
            '''\
            #!/bin/bash
            printf '%s' "$1" > "${ARG_FILE:?}"
            ''',
            exe=True,
        )

    def test_forwards_asset_target(self):
        arg_file = self.tmp / 'arg.txt'
        self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'mirror-assets',
            env={'asset_target': 'harvester', 'ARG_FILE': str(arg_file)},
        )
        self.assertEqual('harvester', arg_file.read_text())

    def test_no_target_is_empty(self):
        arg_file = self.tmp / 'arg.txt'
        self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'mirror-assets',
            env={'ARG_FILE': str(arg_file)},
        )
        self.assertEqual('', arg_file.read_text())


if __name__ == '__main__':
    unittest.main()
