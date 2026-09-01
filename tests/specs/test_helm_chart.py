"""Helm chart: static shape contract (Pod/Deployment wrappers, shared pod spec,
image/endpoint knobs, libvirt/TLS toggles).

No helm is required — these assert on the chart files on disk so CI catches an
accidental kind change (a default Deployment breaks `podman play kube
--replace`/`--down` name matching) or a removed knob without needing the chart
rendered."""
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
                     'deployAs:', 'replicas:', 'httpsPort:', 'webAppHttpsPort:'):
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
        # Deployment mode must not carry podman hostPort / emptyDir.path bits:
        # the partial's else branch (Deployment) uses plain emptyDir, no path.
        self.assertIn('deployAs "Pod"', self.podspec)
        self.assertIn('{{- else }}', self.podspec)
        self.assertIn('emptyDir: {}', self.podspec)

    def test_webapp_has_no_hostport(self):
        # The webapp is internal-only (nginx TLS proxy target); it must not be
        # published as a hostPort in either mode.
        self.assertIn('- name: webapp\n        containerPort: {{ .Values.webAppPort }}', self.podspec)
        self.assertNotIn('hostPort: {{ .Values.webAppPort }}', self.podspec)


if __name__ == '__main__':
    unittest.main()
