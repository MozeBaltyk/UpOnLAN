"""Static safety contract for the privileged WOL network helper."""
import unittest

from tests.specs.helpers import REPO_ROOT


class WolNetworkScriptSpecs(unittest.TestCase):
    def test_discovery_precedes_every_host_change_and_checks_values(self):
        script = (REPO_ROOT / 'scripts' / 'set_docker_networks_for_wol.sh').read_text()
        discovery = script.index('subnet=$(docker network inspect')
        route = script.index('ip -o route show')
        first_change = script.index('sudo sysctl -w')
        self.assertLess(discovery, route)
        self.assertLess(route, first_change)
        self.assertIn('[ -z "$subnet" ]', script)
        self.assertIn('[ -z "${interface:-}" ]', script)
        self.assertNotIn('[ ! -z subnet ]', script)
        self.assertNotIn('[ ! -z interface ]', script)

    def test_start_stops_on_init_failure(self):
        start = (REPO_ROOT / 'src' / 'start.sh').read_text()
        self.assertIn('set -e', start)
        self.assertIn('exec supervisord', start)


if __name__ == '__main__':
    unittest.main()
