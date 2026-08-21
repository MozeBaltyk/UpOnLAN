"""virsh-safe is the security gate in front of the host libvirt socket: the
Containerfile's sudoers entry points at it (not virsh), and its subcommand
whitelist must cover every virsh subcommand the webapp actually invokes."""
import re
import unittest

from tests.specs.helpers import REPO_ROOT


class VirshSafeSpecs(unittest.TestCase):
    def setUp(self):
        self.wrapper = (REPO_ROOT / 'src' / 'virsh-safe').read_text()
        self.containerfile = (REPO_ROOT / 'Containerfile').read_text()
        self.vm_handlers = (REPO_ROOT / 'src' / 'webapp' / 'sockets' / 'vmHandlers.js').read_text()

    def _whitelisted(self):
        """Subcommands from the wrapper's `case "$cmd" in` block."""
        body = self.wrapper.split('case "$cmd" in', 1)[1]
        subcmds = set()
        for line in body.splitlines():
            stripped = line.strip()
            if stripped.endswith(')'):
                names = stripped[:-1].split('|')
                subcmds.update(n.strip() for n in names if re.match(r'^[a-z][a-z-]*$', n.strip()))
        return subcmds

    def test_sudoers_points_at_wrapper_not_virsh(self):
        self.assertIn('NOPASSWD:/usr/local/bin/virsh-safe', self.containerfile)
        self.assertNotIn('/usr/bin/virsh *', self.containerfile)

    def test_webapp_invokes_wrapper_path(self):
        # Both the generic runner and the console attach must go through the wrapper.
        self.assertIn("spawn('sudo', ['/usr/local/bin/virsh-safe', ...args])", self.vm_handlers)
        self.assertIn('sudo /usr/local/bin/virsh-safe console --force', self.vm_handlers)
        self.assertNotIn("spawn('sudo', ['virsh'", self.vm_handlers)

    def test_whitelist_covers_every_called_subcommand(self):
        called = set(re.findall(r"runVirsh\(\['([a-z][a-z-]*)'", self.vm_handlers))
        called.add('console')  # the console attach calls it via `script`, not runVirsh
        whitelisted = self._whitelisted()
        missing = called - whitelisted
        self.assertFalse(missing, f'subcommands called but not whitelisted: {sorted(missing)}')

    def test_wrapper_execs_real_virsh(self):
        self.assertIn('exec /usr/bin/virsh "$cmd" "$@"', self.wrapper)

    def test_define_paths_are_pinned(self):
        # define/net-define accept only the exact /tmp paths vmHandlers writes.
        self.assertIn('/tmp/uponlan-*.xml', self.wrapper)
        self.assertIn('/tmp/uponlan-net-*.xml', self.wrapper)


if __name__ == '__main__':
    unittest.main()
