#!/usr/bin/env bash
# Build iPXE ROMs and boot media with CONSOLE_SERIAL + a dhcp-first embedded
# chain -> menu.ipxe.
#
# Usage:
#   build_ipxe_roms.sh                     # release set (TFTP binaries + e1000 option ROM)
#   build_ipxe_roms.sh legacy,efi,iso,usb  # boot media (media mode)
#   OUT_ROM=/path build_ipxe_roms.sh ...   # override the output dir (default release/menus/rom/ipxe)
#
# release set:
#   bin/undionly.kpxe        -> uponlan.xyz-undionly.kpxe  (firmware PXE stage-1)
#   bin/ipxe.pxe             -> uponlan.xyz.kpxe           (iPXE stage-2, dhcp-boot)
#   bin-x86_64-efi/ipxe.efi  -> uponlan.xyz.efi            (UEFI clients)
#   bin/8086100e.rom         -> uponlan.xyz-e1000.rom      (BIOS NIC option ROM)
#
# media mode (formats: legacy, efi, iso, usb):
#   legacy: uponlan.xyz.{kpxe,dsk,pdsk,lkrn} + uponlan.xyz-undionly.kpxe
#   efi:    uponlan.xyz.efi, uponlan.xyz-snp.efi, uponlan.xyz-snponly.efi
#   iso:    uponlan.xyz.iso   (genfsimg: needs lkrn + efi, built automatically)
#   usb:    uponlan.xyz.img   (genfsimg: needs lkrn + efi, built automatically)
#
# Notes:
# - ipxe-gas242-binutils.patch: binutils 2.42 rejects `.arch i386/i586` in
#   64-bit default mode (EFI targets). Patch moves the `.codeXX` mode directive
#   before `.arch`; semantics for 16/32-bit BIOS builds are unchanged.
# - NO_WERROR=1: gcc 13 trips -Werror=array-bounds in core/acpi.c.
# - liblzma-dev is required (zbin compresses the ROM images).
set -euo pipefail

IPXE_VERSION="${IPXE_VERSION:-1.21.1}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Output dir. release mode defaults to the runtime TFTP path (packed into
# menus.tar.gz); the container's Build UI overrides OUT_ROM to /config/menus/rom/ipxe.
OUT_ROM="${OUT_ROM:-$REPO_ROOT/release/menus/rom/ipxe}"
# Host-side path QEMU reads as the NIC's option ROM (release mode installs here).
PXE_ROM_PATH="${PXE_ROM_PATH:-/usr/lib/ipxe/qemu/uponlan-e1000.rom}"
# Comma-separated formats: release (default) | legacy,efi,iso,usb
FORMATS="${1:-release}"

WORK="$(mktemp -d /tmp/ipxe-build-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

command -v make gcc curl >/dev/null
if ! command -v lzma >/dev/null; then
  echo "ERROR: 'lzma' not found - the iPXE ROM build requires liblzma-dev (and xz-utils)." >&2
  echo "       Install it: sudo apt-get install -y liblzma-dev xz-utils" >&2
  exit 1
fi

echo "[ipxe] fetching iPXE v$IPXE_VERSION"
curl -fsSL -o "$WORK/ipxe.tar.gz" "https://github.com/ipxe/ipxe/archive/refs/tags/v${IPXE_VERSION}.tar.gz"
mkdir -p "$WORK/ipxe"
tar -xzf "$WORK/ipxe.tar.gz" -C "$WORK/ipxe" --strip-components=1
cd "$WORK/ipxe/src"

echo "[ipxe] applying binutils-2.42 patch"
patch -p1 -f < "$REPO_ROOT/scripts/ipxe-gas242-binutils.patch"

echo "[ipxe] enabling serial console"
mkdir -p config/local
printf '#define CONSOLE_SERIAL\n' > config/local/console.h

cat > "$WORK/embed.ipxe" <<'EOF'
#!ipxe
# Network must be established before chaining: on a fresh option-ROM boot there
# is no configuration yet, and menu.ipxe's own `isset ${ip} || dhcp` would never
# run because `chain` itself fails first.
dhcp || goto dhcp_failed
chain --autofree menu.ipxe || goto menu_failed

:dhcp_failed
echo DHCP failed - no network response on the PXE NIC
echo Check the uponlan network is active and the container DHCP/TFTP is running
shell

:menu_failed
echo Failed to load menu.ipxe from the boot server
echo Check TFTP serving, file presence, and file ownership (--tftp-secure)
shell
EOF

# Resolve the make targets + artifact mapping from the requested formats.
make_targets=""
artifacts=()
gen_iso=0 gen_usb=0
IFS=',' read -ra FMT <<< "$FORMATS"
for f in "${FMT[@]}"; do
  case "$f" in
    release)
      make_targets="$make_targets bin/undionly.kpxe bin/ipxe.pxe bin-x86_64-efi/ipxe.efi bin/8086100e.rom"
      artifacts+=("bin/undionly.kpxe:uponlan.xyz-undionly.kpxe")
      artifacts+=("bin/ipxe.pxe:uponlan.xyz.kpxe")
      artifacts+=("bin-x86_64-efi/ipxe.efi:uponlan.xyz.efi")
      artifacts+=("bin/8086100e.rom:uponlan.xyz-e1000.rom")
      ;;
    legacy)
      make_targets="$make_targets bin/ipxe.kpxe bin/ipxe.dsk bin/ipxe.pdsk bin/ipxe.lkrn bin/undionly.kpxe"
      artifacts+=("bin/ipxe.kpxe:uponlan.xyz.kpxe")
      artifacts+=("bin/ipxe.dsk:uponlan.xyz.dsk")
      artifacts+=("bin/ipxe.pdsk:uponlan.xyz.pdsk")
      artifacts+=("bin/ipxe.lkrn:uponlan.xyz.lkrn")
      artifacts+=("bin/undionly.kpxe:uponlan.xyz-undionly.kpxe")
      ;;
    efi)
      make_targets="$make_targets bin-x86_64-efi/ipxe.efi bin-x86_64-efi/snp.efi bin-x86_64-efi/snponly.efi"
      artifacts+=("bin-x86_64-efi/ipxe.efi:uponlan.xyz.efi")
      artifacts+=("bin-x86_64-efi/snp.efi:uponlan.xyz-snp.efi")
      artifacts+=("bin-x86_64-efi/snponly.efi:uponlan.xyz-snponly.efi")
      ;;
    iso) gen_iso=1 ;;
    usb) gen_usb=1 ;;
    *) echo "ERROR: unknown format '$f' (expected release|legacy|efi|iso|usb)" >&2; exit 1 ;;
  esac
done

# ISO/USB images are built by genfsimg from the lkrn + efi binaries.
if [ "$gen_iso" = 1 ] || [ "$gen_usb" = 1 ]; then
  make_targets="$make_targets bin/ipxe.lkrn bin-x86_64-efi/ipxe.efi"
fi

echo "[ipxe] building: $FORMATS"
# shellcheck disable=SC2086
make -j"$(nproc)" $make_targets EMBED="$WORK/embed.ipxe" NO_WERROR=1

mkdir -p "$OUT_ROM"
for pair in "${artifacts[@]}"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  cp "$src" "$OUT_ROM/$dst"
done

if [ "$gen_iso" = 1 ]; then
  echo "[ipxe] generating ISO"
  ./util/genfsimg -o "$OUT_ROM/uponlan.xyz.iso" -s uponlan.xyz \
    bin-x86_64-efi/ipxe.efi bin/ipxe.lkrn
fi
if [ "$gen_usb" = 1 ]; then
  echo "[ipxe] generating USB image"
  ./util/genfsimg -o "$OUT_ROM/uponlan.xyz.img" -s uponlan.xyz \
    bin-x86_64-efi/ipxe.efi bin/ipxe.lkrn
fi

# Install the built e1000 option ROM where QEMU loads it from (the domain XML
# emitted by buildDomainXml references this exact path), then VERIFY the
# installed bytes match what was built - the acceptance criteria require a
# checksum/comparison check, not just "file exists". Release mode only: the
# container's media build has no host to install into.
install_host_rom() {
  local src="$1" dest="$PXE_ROM_PATH" dir
  dir="$(dirname "$dest")"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" 2>/dev/null || sudo -n mkdir -p "$dir" 2>/dev/null || {
      echo "ERROR: cannot create $dir (need root?)" >&2
      return 1
    }
  fi
  if [ -w "$dir" ]; then
    cp "$src" "$dest"
  elif ! sudo -n cp "$src" "$dest" 2>/dev/null; then
    echo "ERROR: cannot write $dest (need root). Install it with:" >&2
    echo "  sudo cp $OUT_ROM/uponlan.xyz-e1000.rom $dest" >&2
    return 1
  fi
  if ! cmp -s "$src" "$dest"; then
    echo "ERROR: installed ROM at $dest does not match the freshly built ROM" >&2
    return 1
  fi
  echo "[ipxe] installed + verified NIC option ROM -> $dest"
}

if [ "$FORMATS" = "release" ]; then
  install_host_rom "$WORK/ipxe/src/bin/8086100e.rom"
fi

echo "[ipxe] done -> $OUT_ROM"
