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

    def test_empty_menu_version_is_resolved_not_left_blank(self):
        # The chart injects MENU_VERSION even when it is an empty string, so
        # init.sh must treat empty and unset the same way (`${MENU_VERSION:-}`),
        # not `${MENU_VERSION+x}`.
        self.assertIn('if [[ -z "${MENU_VERSION:-}" ]]; then', self.init_sh)
        self.assertNotIn('if [[ -z ${MENU_VERSION+x} ]]; then', self.init_sh)

    def test_endpoints_catalog_is_refreshed_on_startup(self):
        # endpoints.yml is generated state and should refresh from the endpoint
        # on every boot, falling back to the existing local copy if the fetch
        # fails. This avoids stale empty catalogs after new assets are released.
        self.assertIn('curl -fsL ${endpoint_catalog_url} -o /tmp/endpoints.yml', self.init_sh)
        self.assertIn('Keeping existing /config/endpoints.yml (refresh failed)', self.init_sh)

    def test_tls_block(self):
        # HTTPS is enabled only when a server cert+key are mounted; the site-conf
        # is written from the TLS template with a shell-format list that leaves
        # nginx's own $host / $http_upgrade variables intact.
        self.assertIn('/config/tls/server.crt', self.init_sh)
        self.assertIn('/config/tls/server.key', self.init_sh)
        self.assertIn("envsubst '${HTTPS_PORT} ${WEBAPP_HTTPS_PORT} ${WEB_APP_PORT}'", self.init_sh)
        self.assertIn('/defaults/tls', self.init_sh)
        self.assertIn('/config/nginx/site-confs/tls', self.init_sh)

    def test_ca_trust_block(self):
        # A mounted corporate CA (TLS-inspecting proxy) is added to the system
        # trust store so curl trusts it; Node reads the refreshed bundle via
        # NODE_EXTRA_CA_CERTS in supervisor.conf.
        self.assertIn('update-ca-certificates', self.init_sh)
        self.assertIn('/config/certs/', self.init_sh)
        self.assertIn('/usr/local/share/ca-certificates', self.init_sh)
        supervisor = (REPO_ROOT / 'src' / 'etc' / 'supervisor.conf').read_text()
        self.assertIn('NODE_EXTRA_CA_CERTS="/etc/ssl/certs/ca-certificates.crt"', supervisor)

    def test_provisioning_profiles_are_relocated_from_menu_tarball(self):
        # Provisioning ships inside menus.tar.gz; init.sh moves it out of the
        # menu tree into the editable + served trees (never overwriting edits).
        self.assertIn('/config/menus/remote/provisioning', self.init_sh)
        self.assertIn('/config/provisioning/local', self.init_sh)
        self.assertIn('/assets/provisioning', self.init_sh)
        self.assertIn('! -e "$dst/$rel"', self.init_sh)
        self.assertIn('rm -rf /config/menus/remote/provisioning', self.init_sh)
        # No longer seeded from an image-baked /defaults/provisioning.
        self.assertNotIn('/defaults/provisioning', self.init_sh)

    def test_menu_release_bundles_provisioning(self):
        release_menu = (REPO_ROOT / 'scripts' / 'release_menu.sh').read_text()
        self.assertIn('./release/provisioning/. "$stage/provisioning"', release_menu)
        self.assertNotIn('--exclude=local-vars.ipxe .', release_menu)


if __name__ == '__main__':
    unittest.main()
