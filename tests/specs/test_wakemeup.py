"""wakemeup.sh CLI: deploy --local gates + mirror-assets asset_target forwarding."""
import os
import unittest

from tests.specs.helpers import TempDirTestCase, STUB_SUDO, STUB_PYTHON3


class DeployLocalSpecs(TempDirTestCase):
    AUTH = {'WEBAPP_USER': 'admin', 'WEBAPP_PASS': 'test-password'}

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
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local', check=False, env=self.AUTH)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('assets/endpoints.yml', proc.stdout + proc.stderr)

    def test_requires_menu_tarball(self):
        self.stub('release/output/assets/endpoints.yml', 'endpoints: {}\n')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local', check=False, env=self.AUTH)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('menu/0.1.0/menus.tar.gz', proc.stdout + proc.stderr)

    def test_deploys_when_both_present(self):
        self.stub('release/output/assets/endpoints.yml', 'endpoints: {}\n')
        self.stub('release/output/menu/0.1.0/menus.tar.gz', 'menu')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local', env=self.AUTH)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_build_flag_is_accepted(self):
        # --build (with --local) builds the local image and serves local assets;
        # with sudo/helm stubbed the whole path should still complete.
        self.stub('release/output/assets/endpoints.yml', 'endpoints: {}\n')
        self.stub('release/output/menu/0.1.0/menus.tar.gz', 'menu')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', '--local', '--build', env=self.AUTH)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_kube_play_feeds_stdin(self):
        # podman play kube must read the rendered chart from stdin ('-'): without
        # it the manifest is discarded and play kube fails with "accepts 1 arg".
        src = (self.tmp / 'wakemeup.sh').read_text()
        self.assertIn('podman play kube "$@" -', src)


class DeployAuthSpecs(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.copy('wakemeup.sh')
        self.stub('bin/podman', '#!/bin/bash\nexit 0\n', exe=True)
        self.stub('bin/ss', '#!/bin/bash\nexit 0\n', exe=True)
        self.stub(
            'bin/sudo',
            '#!/bin/bash\nprintf "%s\\n" "$*" >> "${SUDO_LOG:?}"\nexit 0\n',
            exe=True,
        )
        self.stub(
            'bin/helm',
            '''\
            #!/bin/bash
            printf '%s\n' "$@" > "${HELM_ARGS:?}"
            for arg in "$@"; do
              case "$arg" in
                webappAuth.user=*)
                  file="${arg#*=}"
                  cmp -s "$file" <(printf '%s' "$WEBAPP_USER") || exit 9
                  printf '%s %s %s\n' "$arg" "$(stat -c %a "$file")" "$(stat -c %a "$(dirname "$file")")" >> "${AUTH_FILES:?}"
                  ;;
                webappAuth.password=*)
                  file="${arg#*=}"
                  cmp -s "$file" <(printf '%s' "$WEBAPP_PASS") || exit 9
                  printf '%s %s %s\n' "$arg" "$(stat -c %a "$file")" "$(stat -c %a "$(dirname "$file")")" >> "${AUTH_FILES:?}"
                  ;;
              esac
            done
            exit "${HELM_EXIT:-0}"
            ''',
            exe=True,
        )

    def _paths(self, args_file):
        return [line.split('=', 1)[1] for line in args_file.read_text().splitlines()
                if line.startswith(('webappAuth.user=', 'webappAuth.password='))]

    def test_noninteractive_deploy_without_credentials_omits_auth(self):
        args_file = self.tmp / 'helm-args.txt'
        sudo_log = self.tmp / 'sudo.log'
        proc = self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'deploy',
            env={
                'WEBAPP_USER': '', 'WEBAPP_PASS': '',
                'HELM_ARGS': str(args_file), 'SUDO_LOG': str(sudo_log),
            },
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn('webappAuth.', args_file.read_text())

    def test_exported_credentials_use_temporary_set_files_and_are_cleaned(self):
        args_file = self.tmp / 'helm-args.txt'
        auth_files = self.tmp / 'auth-files.txt'
        sudo_log = self.tmp / 'sudo.log'
        password = 'secret with spaces;$HOME'
        proc = self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'deploy',
            env={
                'WEBAPP_USER': 'operator', 'WEBAPP_PASS': password,
                'HELM_ARGS': str(args_file), 'AUTH_FILES': str(auth_files),
                'SUDO_LOG': str(sudo_log),
            },
        )
        output = proc.stdout + proc.stderr
        args = args_file.read_text()
        self.assertEqual(proc.returncode, 0, output)
        self.assertIn('--set-file', args)
        self.assertIn('webappAuth.user=', args)
        self.assertIn('webappAuth.password=', args)
        self.assertNotIn('operator', args)
        self.assertNotIn(password, args)
        self.assertNotIn(password, output)
        self.assertTrue(all(line.endswith(' 600 700') for line in auth_files.read_text().splitlines()))
        self.assertTrue(all(not os.path.exists(path) for path in self._paths(args_file)))

    def test_temporary_files_are_cleaned_when_helm_fails(self):
        args_file = self.tmp / 'helm-args.txt'
        auth_files = self.tmp / 'auth-files.txt'
        proc = self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'deploy', check=False,
            env={
                'WEBAPP_USER': 'operator', 'WEBAPP_PASS': 'secret',
                'HELM_ARGS': str(args_file), 'AUTH_FILES': str(auth_files),
                'SUDO_LOG': str(self.tmp / 'sudo.log'), 'HELM_EXIT': '1',
            },
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(all(not os.path.exists(path) for path in self._paths(args_file)))

    def test_okd_values_pass_url_and_canonical_host_path_without_secret_contents(self):
        args_file = self.tmp / 'helm-args.txt'
        secret = self.tmp / 'okd-pull-secret'
        secret_value = '{"auths":{"quay.io":{"auth":"must-not-leak"}}}'
        secret.write_text(secret_value)
        proc = self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'deploy',
            env={
                'WEBAPP_USER': 'operator', 'WEBAPP_PASS': 'secret',
                'HELM_ARGS': str(args_file), 'AUTH_FILES': str(self.tmp / 'auth-files.txt'),
                'SUDO_LOG': str(self.tmp / 'sudo.log'),
                'OKD_PUBLIC_BASE_URL': 'https://pxe.example.com/',
                'OKD_PULL_SECRET_FILE': str(secret),
            },
        )
        args = args_file.read_text()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('okd.publicBaseUrl=https://pxe.example.com/', args)
        self.assertIn(f'okd.pullSecret.hostPath={secret.resolve()}', args)
        self.assertNotIn(secret_value, args + proc.stdout + proc.stderr)

    def test_okd_secret_path_must_be_absolute_regular_and_not_a_symlink(self):
        target = self.tmp / 'pull-secret'
        target.write_text('{"auths":{}}')
        link = self.tmp / 'pull-secret-link'
        link.symlink_to(target)
        common = {
            'WEBAPP_USER': 'operator', 'WEBAPP_PASS': 'secret',
            'HELM_ARGS': str(self.tmp / 'helm-args.txt'),
            'AUTH_FILES': str(self.tmp / 'auth-files.txt'),
            'SUDO_LOG': str(self.tmp / 'sudo.log'),
            'OKD_PUBLIC_BASE_URL': 'https://pxe.example.com/',
        }
        for value in ('relative-secret', str(link)):
            proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', check=False,
                                env={**common, 'OKD_PULL_SECRET_FILE': value})
            self.assertNotEqual(proc.returncode, 0)
        self.assertFalse((self.tmp / 'sudo.log').exists())

    def test_internal_secret_configuration_forwards_public_url_independently(self):
        args_file = self.tmp / 'helm-args.txt'
        self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'deploy',
            env={
                'WEBAPP_USER': 'operator', 'WEBAPP_PASS': 'secret',
                'HELM_ARGS': str(args_file), 'AUTH_FILES': str(self.tmp / 'auth-files.txt'),
                'SUDO_LOG': str(self.tmp / 'sudo.log'),
                'OKD_PUBLIC_BASE_URL': 'https://pxe.example.com/',
            },
        )
        args = args_file.read_text()
        self.assertIn('okd.retentionDays=0', args)
        self.assertIn('okd.publicBaseUrl=https://pxe.example.com/', args)
        self.assertNotIn('okd.pullSecret', args)

    def test_rejects_malformed_public_url_without_external_file(self):
        for url in ('http://pxe.example.com/', 'https://pxe.example.com/,bad', 'https://pxe.example.com/\n', 'https://user:dummy@pxe.example.com/', 'https://pxe.example.com/path', 'https://pxe.example.com/?query=yes'):
            proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'deploy', check=False, env={
                'OKD_PUBLIC_BASE_URL': url, 'OKD_PULL_SECRET_FILE': '',
                'HELM_ARGS': str(self.tmp / 'helm-args.txt'), 'SUDO_LOG': str(self.tmp / 'sudo.log'),
            })
            self.assertNotEqual(proc.returncode, 0)


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
        return self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'preview', *args,
            env={'WEBAPP_USER': '', 'WEBAPP_PASS': ''},
        )

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
            env={'SUDO_LOG': str(log), 'WEBAPP_USER': '', 'WEBAPP_PASS': ''},
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
    """release-menu runs release_menu.sh with an explicit version when given,
    else falls back to version.ipxe."""

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

    def test_positional_version_overrides_version_ipxe(self):
        self.stub('release/menus/version.ipxe', 'set menu_version 0.2.0\n')
        arg_file = self.tmp / 'arg.txt'
        self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'release-menu', '0.3.0',
            env={'ARG_FILE': str(arg_file)},
        )
        self.assertEqual('0.3.0', arg_file.read_text())

    def test_errors_without_version(self):
        self.stub('release/menus/version.ipxe', '')
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'release-menu', check=False)
        self.assertNotEqual(proc.returncode, 0)


class TestActionSpecs(TempDirTestCase):
    """`-a test` runs tests/specs on the host, then the full webapp suite in
    the running container."""

    def setUp(self):
        super().setUp()
        self.copy('wakemeup.sh')
        self.stub(
            'tests/specs/run.sh',
            '#!/bin/bash\nprintf host > "${HOST_MARKER:?}"\n',
            exe=True,
        )
        # Minimal sudo stub:
        # - `podman ps --filter name=uponlan-webapp` -> print a fake container id
        # - `podman exec <cid> test -d /webapp/test` -> success (tests baked in)
        # - final `podman exec -it <cid> sh -c ...` -> record the webapp step
        self.stub(
            'bin/sudo',
            '''\
            #!/bin/bash
            if [ "$1" = "podman" ] && [ "$2" = "ps" ]; then
              printf 'fakecid\n'
              exit 0
            fi
            if [ "$1" = "podman" ] && [ "$2" = "exec" ] && [ "$4" = "test" ]; then
              exit 0
            fi
            if [ "$1" = "podman" ] && [ "$2" = "exec" ] && [[ " $* " == *" sh -c "* ]]; then
              printf '%s' "$*" > "${WEBAPP_MARKER:?}"
              exit 0
            fi
            exit 0
            ''',
            exe=True,
        )

    def test_runs_host_specs_then_webapp_suite(self):
        host_marker = self.tmp / 'host.txt'
        webapp_marker = self.tmp / 'webapp.txt'
        proc = self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'test',
            env={'HOST_MARKER': str(host_marker), 'WEBAPP_MARKER': str(webapp_marker)},
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual('host', host_marker.read_text())
        self.assertIn('node node_modules/vitest/vitest.mjs run', webapp_marker.read_text())

    def test_old_test_webapp_alias_is_rejected(self):
        proc = self.run_cmd('bash', 'wakemeup.sh', '-a', 'test-webapp', check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('test - run tests/specs on the host', proc.stdout + proc.stderr)


if __name__ == '__main__':
    unittest.main()
