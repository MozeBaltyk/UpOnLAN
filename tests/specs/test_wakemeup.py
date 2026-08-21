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
        # Preflight runs `ss` to check host ports; stub it so the spec doesn't
        # depend on the real host's port state.
        self.stub('bin/ss', '#!/bin/bash\nexit 0\n', exe=True)
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

    def test_kube_play_feeds_stdin(self):
        # podman play kube must read the rendered chart from stdin ('-'): without
        # it the manifest is discarded and play kube fails with "accepts 1 arg".
        src = (self.tmp / 'wakemeup.sh').read_text()
        self.assertIn('podman play kube "$@" -', src)


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


class PreviewPullPolicySpecs(TempDirTestCase):
    """preview shows the resolved pull policy: Always for ghcr (public image),
    Never for a local build — so a default deploy always fetches the latest
    published `latest` tag instead of reusing a stale cached image."""

    def setUp(self):
        super().setUp()
        self.copy('wakemeup.sh')
        self.stub('bin/sudo', STUB_SUDO, exe=True)
        self.stub('bin/helm', '#!/bin/bash\nexit 0\n', exe=True)
        self.stub('bin/ss', '#!/bin/bash\nexit 0\n', exe=True)

    def _preview(self, *args):
        return self.run_cmd('bash', 'wakemeup.sh', '-a', 'preview', *args)

    def test_default_pull_policy_is_always(self):
        proc = self._preview()
        self.assertIn('(Always)', proc.stdout)

    def test_build_pull_policy_is_never(self):
        proc = self._preview('--build')
        self.assertIn('(Never)', proc.stdout)


class DestroySpecs(TempDirTestCase):
    """destroy removes the image for the deployment mode in effect, not a
    hardcoded localhost build."""

    def setUp(self):
        super().setUp()
        self.copy('wakemeup.sh')
        # Record sudo's argv so the spec can assert the `podman rmi` target.
        self.stub(
            'bin/sudo',
            '#!/bin/bash\nprintf "%s\\n" "$*" >> "${SUDO_LOG:?}"\nexit 0\n',
            exe=True,
        )
        # destroy -> kube_play --down renders the chart through helm.
        self.stub('bin/helm', '#!/bin/bash\nexit 0\n', exe=True)

    def _rmi_lines(self, *args):
        log = self.tmp / 'sudo.log'
        self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'destroy', *args,
            env={'SUDO_LOG': str(log)},
        )
        return [l for l in log.read_text().splitlines() if 'rmi' in l]

    def test_destroy_default_removes_ghcr_image(self):
        rmis = self._rmi_lines()
        self.assertTrue(any('ghcr.io/mozebaltyk/uponlan:latest' in r for r in rmis))

    def test_destroy_build_removes_local_image(self):
        rmis = self._rmi_lines('--build')
        self.assertTrue(any('localhost/uponlan:latest' in r for r in rmis))
        self.assertFalse(any('ghcr.io' in r for r in rmis))


class ReleaseMenuSpecs(TempDirTestCase):
    """release-menu runs release_menu.sh with the version from version.ipxe."""

    def setUp(self):
        super().setUp()
        self.copy('wakemeup.sh')
        self.stub(
            'scripts/release_menu.sh',
            '#!/bin/bash\nprintf "%s" "$1" > "${ARG_FILE:?}"\n',
            exe=True,
        )

    def test_passes_menu_version(self):
        self.stub('release/menus/version.ipxe', 'set menu_version 0.2.0\n')
        arg_file = self.tmp / 'arg.txt'
        self.run_cmd('bash', 'wakemeup.sh', '-a', 'release-menu', env={'ARG_FILE': str(arg_file)})
        self.assertEqual('0.2.0', arg_file.read_text())

    def test_errors_without_version(self):
        self.stub('release/menus/version.ipxe', '')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'release-menu', check=False)
        self.assertNotEqual(proc.returncode, 0)


if __name__ == '__main__':
    unittest.main()
