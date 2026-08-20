"""build_ipxe_roms.sh runtime: format -> targets, two-phase serial split, iso/usb.

The real build needs a network fetch + make/gcc/lzma, so these specs stub every
external command (curl/tar/patch/make/gcc/lzma/genfsimg) and drive the script's
format-parsing + build orchestration against the stubs.
"""
from tests.specs.helpers import TempDirTestCase

# Stub `tar`: parse `-C <dir>` and create `<dir>/src/{config/local,util}` so the
# script's `cd <dir>/src` + `mkdir -p config/local` succeed, and drop a genfsimg
# stub under util/ (the script calls `./util/genfsimg`, a relative path, not PATH).
STUB_TAR = '''\
#!/bin/bash
dir=""
prev=""
for a in "$@"; do
  [ "$prev" = "-C" ] && dir="$a"
  prev="$a"
done
mkdir -p "$dir/src/config/local" "$dir/src/util"
cat > "$dir/src/util/genfsimg" <<'GEN'
#!/bin/bash
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
mkdir -p "$(dirname "$out")"
printf 'iso' > "$out"
exit 0
GEN
chmod +x "$dir/src/util/genfsimg"
exit 0
'''

# Stub `make`: record the invocation (targets + the console.h in effect) to
# $MAKE_LOG, then materialize each requested artifact so the later `cp` works.
STUB_MAKE = '''\
#!/bin/bash
{
  echo "ARGS: $*"
  echo "CONSOLE_H: $(cat config/local/console.h 2>/dev/null || echo '<none>')"
} >> "${MAKE_LOG:?}"
for t in "$@"; do
  case "$t" in
    bin/*|bin-x86_64-efi/*)
      mkdir -p "$(dirname "$t")"
      printf 'artifact' > "$t"
      ;;
  esac
done
exit 0
'''

# Stub `genfsimg`: create the `-o` output so iso/usb artifacts exist.
STUB_GENFSIMG = '''\
#!/bin/bash
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
mkdir -p "$(dirname "$out")"
printf 'iso' > "$out"
exit 0
'''

STUB_NOOP = '#!/bin/bash\nexit 0\n'


class RomBuildFormatsSpecs(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.copy('scripts/build_ipxe_roms.sh')
        self.copy('scripts/ipxe-gas242-binutils.patch')
        self.stub('bin/curl', '#!/bin/bash\nexit 0\n', exe=True)  # fetch is not exercised
        self.stub('bin/tar', STUB_TAR, exe=True)
        self.stub('bin/patch', STUB_NOOP, exe=True)
        self.stub('bin/gcc', STUB_NOOP, exe=True)
        self.stub('bin/lzma', STUB_NOOP, exe=True)
        self.stub('bin/make', STUB_MAKE, exe=True)

    def _run(self, formats):
        self.make_log = self.tmp / 'make.log'
        self.out = self.tmp / 'out'
        self.run_cmd(
            'bash', 'scripts/build_ipxe_roms.sh', formats,
            env={'OUT_ROM': str(self.out), 'MAKE_LOG': str(self.make_log)},
        )
        return self.make_log.read_text()

    def test_two_phase_serial_split(self):
        log = self._run('legacy,efi')
        lines = [l for l in log.split('\n') if l]
        # two make invocations: BIOS (serial) then UEFI (no serial)
        args_lines = [l for l in lines if l.startswith('ARGS: ')]
        console_lines = [l for l in lines if l.startswith('CONSOLE_H: ')]
        self.assertEqual(len(args_lines), 2, f'expected 2 make phases, got: {log}')

        # Phase 1: BIOS targets + CONSOLE_SERIAL
        self.assertIn('bin/ipxe.kpxe', args_lines[0])
        self.assertIn('bin/ipxe.dsk', args_lines[0])
        self.assertIn('bin/undionly.kpxe', args_lines[0])
        self.assertIn('#define CONSOLE_SERIAL', console_lines[0])

        # Phase 2: UEFI targets + no CONSOLE_SERIAL
        self.assertIn('bin-x86_64-efi/ipxe.efi', args_lines[1])
        self.assertIn('bin-x86_64-efi/snp.efi', args_lines[1])
        self.assertIn('bin-x86_64-efi/snponly.efi', args_lines[1])
        self.assertEqual(console_lines[1].strip(), 'CONSOLE_H:')

        # artifacts copied to OUT_ROM
        for name in ('uponlan.xyz.kpxe', 'uponlan.xyz.dsk', 'uponlan.xyz.efi', 'uponlan.xyz-snp.efi'):
            self.assertTrue((self.out / name).is_file(), f'{name} missing')

    def test_iso_and_usb_build_prerequisites_and_images(self):
        log = self._run('iso,usb')
        # genfsimg needs lkrn (BIOS) + efi (UEFI); both are added automatically
        self.assertIn('bin/ipxe.lkrn', log)
        self.assertIn('bin-x86_64-efi/ipxe.efi', log)
        self.assertTrue((self.out / 'uponlan.xyz.iso').is_file())
        self.assertTrue((self.out / 'uponlan.xyz.img').is_file())

    def test_gcc15_flags_are_passed(self):
        log = self._run('efi')
        self.assertIn('-std=gnu11', log)
        self.assertIn('-Wno-error=incompatible-pointer-types', log)


if __name__ == '__main__':
    import unittest
    unittest.main()
