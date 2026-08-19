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
        # GitHub: endpoints.yml at the repo root.
        self.assertIn('${ENDPOINT_URL}/endpoints.yml', self.init_sh)
        # Local mirror: assets/ namespace.
        self.assertIn('${ENDPOINT_URL}/assets/endpoints.yml', self.init_sh)

    def test_branch_condition(self):
        # The GitHub vs local decision keys off the endpoint host.
        self.assertIn('*github.com*', self.init_sh)


if __name__ == '__main__':
    unittest.main()
