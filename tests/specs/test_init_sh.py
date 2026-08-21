"""init.sh must fetch the menu tarball + endpoints.yml from the right path for a
GitHub endpoint vs a local mirror."""
import unittest

from tests.specs.helpers import REPO_ROOT


class InitShUrlSpecs(unittest.TestCase):
    def setUp(self):
        self.init_sh = (REPO_ROOT / 'src' / 'init.sh').read_text()

    def test_menu_tarball_urls(self):
        # GitHub: release assets live under /releases/download/<tag>/.
        self.assertIn('${ENDPOINT_URL}/releases/download/${MENU_VERSION}/menus.tar.gz', self.init_sh)
        # Local mirror: menu/ namespace.
        self.assertIn('${ENDPOINT_URL}/menu/${MENU_VERSION}/menus.tar.gz', self.init_sh)

    def test_endpoints_yml_urls(self):
        # GitHub: endpoints.yml published as a release asset on the 'assets' tag.
        self.assertIn('${ENDPOINT_URL}/releases/download/assets/endpoints.yml', self.init_sh)
        self.assertNotIn('${ENDPOINT_URL}/endpoints.yml"', self.init_sh)
        # Local mirror: assets/ namespace.
        self.assertIn('${ENDPOINT_URL}/assets/endpoints.yml', self.init_sh)

    def test_branch_condition(self):
        # The GitHub vs local decision keys off the endpoint host.
        self.assertIn('*github.com*', self.init_sh)

    def test_ca_trust_block(self):
        # A mounted corporate CA (TLS-inspecting proxy) is added to the system
        # trust store so curl trusts it; Node reads the refreshed bundle via
        # NODE_EXTRA_CA_CERTS in supervisor.conf.
        self.assertIn('update-ca-certificates', self.init_sh)
        self.assertIn('/config/certs/', self.init_sh)
        self.assertIn('/usr/local/share/ca-certificates', self.init_sh)
        supervisor = (REPO_ROOT / 'src' / 'etc' / 'supervisor.conf').read_text()
        self.assertIn('NODE_EXTRA_CA_CERTS="/etc/ssl/certs/ca-certificates.crt"', supervisor)


if __name__ == '__main__':
    unittest.main()
