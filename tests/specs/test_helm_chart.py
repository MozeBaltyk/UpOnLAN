"""Helm chart: static shape contract (Pod kind, image/endpoint knobs, libvirt toggle).

No helm is required — these assert on the chart files on disk so CI catches an
accidental kind change (Deployment breaks `podman play kube --replace`/`--down`
name matching) or a removed knob without needing the chart rendered."""
import unittest

from tests.specs.helpers import REPO_ROOT

CHART = REPO_ROOT / 'charts' / 'uponlan'


class HelmChartSpecs(unittest.TestCase):
    def setUp(self):
        self.chart = (CHART / 'Chart.yaml').read_text()
        self.values = (CHART / 'values.yaml').read_text()
        self.pod = (CHART / 'templates' / 'pod.yaml').read_text()

    def test_chart_metadata(self):
        self.assertIn('apiVersion: v2', self.chart)
        self.assertIn('name: uponlan', self.chart)

    def test_deployment_knobs_present(self):
        for knob in ('image:', 'endpoint:', 'menuVersion:', 'libvirt:'):
            self.assertIn(knob, self.values, f'missing {knob} knob')

    def test_pod_kind_and_templating(self):
        self.assertIn('kind: Pod', self.pod)
        self.assertNotIn('kind: Deployment', self.pod)
        for tpl in ('{{ .Values.image.repository }}', '{{ .Values.endpoint }}',
                    '{{ .Values.menuVersion }}'):
            self.assertIn(tpl, self.pod, f'missing template {tpl}')


if __name__ == '__main__':
    unittest.main()