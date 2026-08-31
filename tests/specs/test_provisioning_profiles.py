"""Shipped provisioning examples must be valid basic installers the menus consume."""
import unittest

import yaml

from tests.specs.helpers import REPO_ROOT


class ProvisioningExampleSpecs(unittest.TestCase):
    """release/provisioning/ ships example kickstart/cloud-init seeds the menu
    chains via ${local_endpoint}provisioning/...; they must parse and carry the
    minimal directives a basic unattended install needs."""

    def setUp(self):
        self.root = REPO_ROOT / 'release' / 'provisioning'

    def test_kickstart_example_is_a_basic_install(self):
        ks = (self.root / 'kickstart' / 'example' / 'ks.cfg').read_text()
        self.assertIn('clearpart --all --initlabel', ks)
        self.assertIn('autopart', ks)
        self.assertIn('network --bootproto=dhcp', ks)
        self.assertIn('%packages', ks)
        self.assertIn('reboot', ks)
        # Password is a SHA-512 crypt hash (the example's plaintext is documented).
        self.assertIn('--iscrypted --password=$6$', ks)

    def test_cloud_init_user_data_is_an_autoinstall_dict(self):
        ud = yaml.safe_load((self.root / 'cloud-init' / 'example' / 'user-data').read_text())
        self.assertIsInstance(ud, dict)
        ai = ud['autoinstall']
        self.assertEqual(ai['version'], 1)
        self.assertEqual(ai['identity']['username'], 'ubuntu')
        self.assertTrue(ai['ssh']['install-server'])
        self.assertEqual(ai['storage']['layout']['name'], 'direct')

    def test_cloud_init_meta_and_network_config_parse(self):
        md = yaml.safe_load((self.root / 'cloud-init' / 'example' / 'meta-data').read_text())
        nc = yaml.safe_load((self.root / 'cloud-init' / 'example' / 'network-config').read_text())
        self.assertIn('instance-id', md)
        self.assertEqual(nc.get('version'), 2)


if __name__ == '__main__':
    unittest.main()
