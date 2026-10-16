"""Helm chart: static shape contract (Pod/Deployment wrappers, shared pod spec,
image/endpoint knobs, libvirt/TLS toggles).

No helm is required — these assert on the chart files on disk so CI catches an
accidental kind change (a default Deployment breaks `podman play kube
--replace`/`--down` name matching) or a removed knob without needing the chart
rendered."""
import shutil
import subprocess
import unittest

from tests.specs.helpers import REPO_ROOT

CHART = REPO_ROOT / 'charts' / 'uponlan'


class HelmChartSpecs(unittest.TestCase):
    def setUp(self):
        self.chart = (CHART / 'Chart.yaml').read_text()
        self.values = (CHART / 'values.yaml').read_text()
        self.pod = (CHART / 'templates' / 'pod.yaml').read_text()
        self.deployment = (CHART / 'templates' / 'deployment.yaml').read_text()
        self.podspec = (CHART / 'templates' / '_podspec.tpl').read_text()

    def test_chart_metadata(self):
        self.assertIn('apiVersion: v2', self.chart)
        self.assertIn('name: uponlan', self.chart)

    def test_deployment_knobs_present(self):
        for knob in ('image:', 'endpoint:', 'menuVersion:', 'libvirt:',
                     'deployAs:', 'replicas:', 'httpsPort:', 'webAppHttpsPort:',
                     'webappAuth:', 'existingSecret:', 'usernameKey:', 'passwordKey:',
                      'okd:', 'publicBaseUrl:', 'retentionDays:', 'pullSecret:', 'hostPath:', 'configClaim:', 'logsClaim:'):
            self.assertIn(knob, self.values, f'missing {knob} knob')

    def test_pod_wrapper_is_gated_and_reuses_spec(self):
        # Default target stays a Pod for podman; the shared spec is in the partial.
        self.assertIn('kind: Pod', self.pod)
        self.assertNotIn('kind: Deployment', self.pod)
        self.assertIn('deployAs "Pod"', self.pod)
        self.assertIn('include "uponlan.podspec"', self.pod)

    def test_deployment_wrapper_shape(self):
        self.assertIn('kind: Deployment', self.deployment)
        self.assertNotIn('kind: Pod', self.deployment)
        self.assertIn('deployAs "Deployment"', self.deployment)
        self.assertIn('replicas: {{ .Values.replicas }}', self.deployment)
        self.assertIn('selector:', self.deployment)
        self.assertIn('include "uponlan.podspec"', self.deployment)

    def test_podspec_templates_and_gates(self):
        for tpl in ('{{ .Values.image.repository }}', '{{ .Values.endpoint }}',
                    '{{ .Values.menuVersion }}', '{{ .Values.httpsPort }}',
                    '{{ .Values.webAppHttpsPort }}', '{{ .Values.webAppPort }}'):
            self.assertIn(tpl, self.podspec, f'missing template {tpl}')
        # Deployment mode must not carry podman hostPort / emptyDir.path bits.
        self.assertIn('deployAs "Pod"', self.podspec)
        self.assertIn('{{- else }}', self.podspec)
        self.assertIn('persistentVolumeClaim:', self.podspec)
        self.assertIn('OKD persistence requires all four config/assets/menu/logs persistentVolumeClaims', self.podspec)

    def test_webapp_auth_template_contract(self):
        self.assertIn('webappAuth.user and webappAuth.password must both be set', self.podspec)
        self.assertIn('name: WEBAPP_USER', self.podspec)
        self.assertIn('name: WEBAPP_PASS', self.podspec)
        self.assertIn('secretKeyRef:', self.podspec)
        self.assertIn('.Values.webappAuth.existingSecret', self.podspec)

    def test_webapp_has_no_hostport(self):
        # The webapp is internal-only (nginx TLS proxy target); it must not be
        # published as a hostPort in either mode.
        self.assertIn('- name: webapp\n        containerPort: {{ .Values.webAppPort }}', self.podspec)
        self.assertNotIn('hostPort: {{ .Values.webAppPort }}', self.podspec)

    def test_okd_security_mount_contract(self):
        self.assertIn('name: OKD_PUBLIC_BASE_URL', self.podspec)
        self.assertIn('name: OKD_PERSISTENCE_READY', self.podspec)
        self.assertIn('name: OKD_RETENTION_DAYS', self.podspec)
        self.assertIn('mountPath: /run/secrets/okd-pull-secret', self.podspec)
        self.assertIn('readOnly: true', self.podspec)
        self.assertIn('defaultMode: 0440', self.podspec)
        self.assertIn('fsGroup: 911', self.deployment)
        self.assertIn('type: Recreate', self.deployment)


@unittest.skipUnless(shutil.which('helm'), 'helm is not installed')
class HelmAuthRenderSpecs(unittest.TestCase):
    def render(self, *settings, check=True):
        cmd = ['helm', 'template', 'uponlan', str(CHART)]
        for setting in settings:
            cmd.extend(('--set-string', setting))
        return subprocess.run(cmd, text=True, capture_output=True, check=check)

    def test_default_omits_webapp_auth(self):
        rendered = self.render().stdout
        self.assertNotIn('name: WEBAPP_USER', rendered)
        self.assertNotIn('name: WEBAPP_PASS', rendered)

    def test_direct_auth_renders_literal_environment(self):
        rendered = self.render('webappAuth.user=operator', 'webappAuth.password=test-secret').stdout
        self.assertIn('name: WEBAPP_USER\n          value: "operator"', rendered)
        self.assertIn('name: WEBAPP_PASS\n          value: "test-secret"', rendered)

    def test_only_one_direct_value_fails(self):
        proc = self.render('webappAuth.user=operator', check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('webappAuth.user and webappAuth.password must both be set', proc.stderr)

    def test_existing_secret_takes_precedence_and_uses_configured_keys(self):
        rendered = self.render(
            'webappAuth.existingSecret=uponlan-webapp-auth',
            'webappAuth.user=ignored-without-password',
            'webappAuth.usernameKey=login',
            'webappAuth.passwordKey=credential',
        ).stdout
        self.assertIn('name: "uponlan-webapp-auth"\n              key: "login"', rendered)
        self.assertIn('name: "uponlan-webapp-auth"\n              key: "credential"', rendered)
        self.assertNotIn('ignored-without-password', rendered)

    def test_default_pod_uses_host_backing_and_is_persistence_ready(self):
        rendered = self.render().stdout
        self.assertRegex(rendered, r'name: OKD_PERSISTENCE_READY\n\s+value: "true"')
        self.assertIn('path: ./config', rendered)
        self.assertRegex(rendered, r'name: OKD_RETENTION_DAYS\n\s+value: "0"')

    def test_default_deployment_keeps_emptydir_and_disables_okd_generation(self):
        rendered = self.render('deployAs=Deployment').stdout
        self.assertRegex(rendered, r'name: OKD_PERSISTENCE_READY\n\s+value: "false"')
        self.assertGreaterEqual(rendered.count('emptyDir: {}'), 4)
        self.assertNotIn('persistentVolumeClaim:', rendered)

    def test_deployment_rejects_partial_okd_persistence(self):
        proc = self.render('deployAs=Deployment', 'okd.persistence.configClaim=config-pvc', check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('OKD persistence requires all four config/assets/menu/logs persistentVolumeClaims', proc.stderr)

    def test_deployment_renders_pvcs_and_read_only_okd_secret(self):
        rendered = self.render(
            'deployAs=Deployment', 'okd.persistence.configClaim=config-pvc',
            'okd.persistence.assetsClaim=assets-pvc', 'okd.persistence.menuClaim=menu-pvc',
            'okd.persistence.logsClaim=logs-pvc', 'okd.pullSecret.existingSecret=okd-pull',
            'okd.publicBaseUrl=https://pxe.example.com/',
        ).stdout
        for claim in ('config-pvc', 'assets-pvc', 'menu-pvc', 'logs-pvc'):
            self.assertIn(f'claimName: "{claim}"', rendered)
        self.assertRegex(rendered, r'name: OKD_PERSISTENCE_READY\n\s+value: "true"')
        self.assertIn('mountPath: /run/secrets/okd-pull-secret', rendered)
        self.assertIn('readOnly: true', rendered)
        self.assertIn('type: Recreate', rendered)
        self.assertIn('fsGroup: 911', rendered)
        self.assertIn('defaultMode: 0440', rendered)  # owner/group read only
        self.assertNotIn('privileged: true', rendered)

    def test_deployment_requires_one_replica_with_or_without_pvcs(self):
        pvcs = (
            'okd.persistence.configClaim=config-pvc', 'okd.persistence.assetsClaim=assets-pvc',
            'okd.persistence.menuClaim=menu-pvc', 'okd.persistence.logsClaim=logs-pvc',
        )
        for storage in ((), pvcs):
            with self.subTest(storage='pvc' if storage else 'ephemeral'):
                proc = self.render('deployAs=Deployment', 'replicas=2', *storage, check=False)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn('Deployment requires replicas=1', proc.stderr)

    def test_deployment_with_one_replica_renders(self):
        rendered = self.render('deployAs=Deployment', 'replicas=1').stdout
        self.assertIn('kind: Deployment', rendered)
        self.assertIn('replicas: 1', rendered)

    def test_pod_renders_pull_secret_host_file_without_secret_contents(self):
        rendered = self.render(
            'okd.publicBaseUrl=https://pxe.example.com/',
            'okd.pullSecret.hostPath=/srv/uponlan/okd-pull-secret',
        ).stdout
        self.assertRegex(rendered, r'path: "/srv/uponlan/okd-pull-secret"\n\s+type: File')
        self.assertRegex(rendered, r'mountPath: /run/secrets/okd-pull-secret\n\s+readOnly: true')
        self.assertNotIn('secretName:', rendered)


if __name__ == '__main__':
    unittest.main()
