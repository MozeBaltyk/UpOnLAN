#!/usr/bin/env bash
# Build the iPXE ROMs the PXE network advertises and the test VM's NIC loads.
#
# Produces (with CONSOLE_SERIAL + a dhcp-first embedded chain -> menu.ipxe):
#   bin/undionly.kpxe        -> uponlan.xyz-undionly.kpxe  (firmware PXE stage-1)
#   bin/ipxe.pxe             -> uponlan.xyz.kpxe           (iPXE stage-2, dhcp-boot)
#   bin-x86_64-efi/ipxe.efi  -> uponlan.xyz.efi            (UEFI clients)
#   bin/8086100e.rom         -> uponlan.xyz-e1000.rom      (BIOS NIC option ROM)
#
# Output goes to release/menus/rom/ipxe/ — the RUNTIME TFTP path: the network's
# dhcp-boot/pxe-service answers (rom/ipxe/uponlan.xyz-*) are relative to the
# TFTP root /config/menus, and release_menu.sh packs this dir into menus.tar.gz
# which the container extracts to /config/menus. Do NOT also stage into
# release/menus/ipxe/ unless you want the ROMs published as flat top-level
# release downloads (release_menu.sh mv's that dir out of the tree on release).
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
OUT_ROM="$REPO_ROOT/release/menus/rom/ipxe"
# Host-side path QEMU reads as the NIC's option ROM (must exist on the host).
PXE_ROM_PATH="${PXE_ROM_PATH:-/usr/lib/ipxe/qemu/uponlan-e1000.rom}"
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

echo "[ipxe] building ROMs"
make -j"$(nproc)" bin/undionly.kpxe bin/ipxe.pxe bin-x86_64-efi/ipxe.efi bin/8086100e.rom \
  EMBED="$WORK/embed.ipxe" NO_WERROR=1

mkdir -p "$OUT_ROM"
for pair in \
  "bin/undionly.kpxe:uponlan.xyz-undionly.kpxe" \
  "bin/ipxe.pxe:uponlan.xyz.kpxe" \
  "bin-x86_64-efi/ipxe.efi:uponlan.xyz.efi" \
  "bin/8086100e.rom:uponlan.xyz-e1000.rom"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  cp "$src" "$OUT_ROM/$dst"
done

# Install the built e1000 option ROM where QEMU loads it from (the domain XML
# emitted by buildDomainXml references this exact path), then VERIFY the
# installed bytes match what was built - the acceptance criteria require a
# checksum/comparison check, not just "file exists".
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

install_host_rom "$WORK/ipxe/src/bin/8086100e.rom"

echo "[ipxe] done -> $OUT_ROM"