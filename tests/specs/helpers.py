"""Shared helpers for the release-flow specs in tests/specs/."""
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]

# Stub for `curl`: build.sh downloads via `curl -o <file> <url>`; this just
# materializes the -o target so the specs never touch the network.
STUB_CURL = textwrap.dedent(
    '''\
    #!/bin/bash
    out=""
    prev=""
    for a in "$@"; do
      [ "$prev" = "-o" ] && out="$a"
      prev="$a"
    done
    mkdir -p "$(dirname "$out")"
    printf 'asset' > "$out"
    '''
)

STUB_SUDO = '#!/bin/bash\nexit 0\n'
STUB_PYTHON3 = '#!/bin/bash\nexit 0\n'

# Stub for `7z`: build.sh iso_extraction runs `7z e <iso> <src> -o<dir> -y` to
# pull a file out of the ISO. This materializes the file named basename(<src>)
# into the -o directory so the specs never touch the network or need 7z.
STUB_7Z = textwrap.dedent(
    '''\
    #!/bin/bash
    src="${3}"
    dir=""
    for a in "$@"; do
      case "$a" in
        -o*) dir="${a#-o}" ;;
      esac
    done
    mkdir -p "$dir"
    printf 'extracted' > "$dir/$(basename "$src")"
    '''
)

# Fixtures for the iPXE ROM artifacts release_menu.sh bundles when present.
ROM_ARTIFACTS = (
    'uponlan.xyz-undionly.kpxe',
    'uponlan.xyz.kpxe',
    'uponlan.xyz.efi',
    'uponlan.xyz-e1000.rom',
)


def write_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def write_exe(path: Path, content: str) -> None:
    write_file(path, content)
    path.chmod(path.stat().st_mode | 0o111)


def extract(content: str, pattern: str) -> str:
    """Return the first regex group, asserting the pattern is present."""
    m = re.search(pattern, content)
    assert m is not None, f'pattern {pattern!r} not found'
    return m.group(1)


class TempDirTestCase(unittest.TestCase):
    """Base test case that runs scripts in an isolated repo-like temp dir.

    `self.tmp` is a fresh directory; `self.copy()` pulls a real repo file into
    it, `self.stub()` writes a fixture/stub, and `self.run_cmd()` runs a command
    from the temp dir with the `bin/` stub dir prepended to PATH.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='uponlan-spec-'))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def copy(self, rel: str) -> Path:
        """Copy a real repo file into the temp dir, preserving its path."""
        dst = self.tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / rel, dst)
        return dst

    def stub(self, rel: str, content: str, exe: bool = False) -> Path:
        """Write a fixture/stub file into the temp dir."""
        p = self.tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(textwrap.dedent(content).lstrip('\n'))
        if exe:
            p.chmod(p.stat().st_mode | 0o111)
        return p

    def run_cmd(self, *args, check=True, env=None, cwd=None):
        merged = dict(os.environ)
        merged['PATH'] = f"{self.tmp / 'bin'}:{os.environ['PATH']}"
        if env:
            merged.update(env)
        return subprocess.run(
            args, cwd=(self.tmp if cwd is None else self.tmp / cwd),
            env=merged, text=True, capture_output=True, check=check,
        )

    def stub_rom_artifacts(self):
        """Create the non-empty rom/ipxe artifacts release_menu.sh bundles when present."""
        for f in ROM_ARTIFACTS:
            write_file(self.tmp / 'release' / 'menus' / 'rom' / 'ipxe' / f, 'rom')
