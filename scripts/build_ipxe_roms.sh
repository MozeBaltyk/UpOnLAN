#!/usr/bin/env bash
# Build iPXE ROMs and boot media with a dhcp-first embedded chain -> menu.ipxe.
#
# Usage:
#   build_ipxe_roms.sh                     # release set (TFTP binaries)
#   build_ipxe_roms.sh legacy,efi,iso,usb  # boot media (media mode)
#   OUT_ROM=/path build_ipxe_roms.sh ...   # override the output dir (default release/menus/rom/ipxe)
#   TRUST=ca.pem CERT=client.pem build_ipxe_roms.sh ...  # embed HTTPS trust (optional)
#   IPXE_TARBALL=/path build_ipxe_roms.sh ...  # use a vendored iPXE source tarball (offline)
#
# release set:
#   bin/undionly.kpxe        -> uponlan.xyz-undionly.kpxe  (firmware PXE stage-1)
#   bin/ipxe.pxe             -> uponlan.xyz.kpxe           (iPXE stage-2, dhcp-boot)
#   bin-x86_64-efi/ipxe.efi  -> uponlan.xyz.efi            (UEFI clients)
#
# media mode (formats: legacy, efi, iso, usb):
#   legacy: uponlan.xyz.{kpxe,dsk,pdsk,lkrn} + uponlan.xyz-undionly.kpxe
#   efi:    uponlan.xyz.efi, uponlan.xyz-snp.efi, uponlan.xyz-snponly.efi
#   iso:    uponlan.xyz.iso   (genfsimg: needs lkrn + efi, built automatically)
#   usb:    uponlan.xyz.img   (genfsimg: needs lkrn + efi, built automatically)
#
# Serial console is per-firmware: BIOS targets are built with CONSOLE_SERIAL
# (SeaBIOS has no serial output); UEFI targets are built WITHOUT it, because
# OVMF already redirects its console to the serial port and a second (iPXE)
# serial writer doubles every character on the UEFI console.
#
# Notes:
# - ipxe-gas242-binutils.patch: binutils 2.42 rejects `.arch i386/i586` in
#   64-bit default mode (EFI targets). Patch moves the `.codeXX` mode directive
#   before `.arch`; semantics for 16/32-bit BIOS builds are unchanged.
# - gcc 14/15 defaults to C23 and promotes several legacy-C warnings to hard
#   errors; the build pins -std=gnu11 and downgrades them (see EXTRA_CFLAGS_VAL).
# - liblzma-dev is required (zbin compresses the ROM images).
set -euo pipefail

IPXE_VERSION="${IPXE_VERSION:-1.21.1}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Output dir. release mode defaults to the runtime TFTP path (packed into
# menus.tar.gz); the container's Build UI overrides OUT_ROM to /config/menus/rom/ipxe.
OUT_ROM="${OUT_ROM:-$REPO_ROOT/release/menus/rom/ipxe}"
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

# Source tarball: prefer a vendored copy (the container ships one at
# /opt/ipxe/ipxe-<ver>.tar.gz so the deploy-time build works offline), falling
# back to GitHub for host builds / version overrides.
IPXE_TARBALL="${IPXE_TARBALL:-/opt/ipxe/ipxe-${IPXE_VERSION}.tar.gz}"
if [[ -f "$IPXE_TARBALL" ]]; then
  echo "[ipxe] using vendored iPXE source $IPXE_TARBALL (offline)"
  cp "$IPXE_TARBALL" "$WORK/ipxe.tar.gz"
else
  echo "[ipxe] fetching iPXE v$IPXE_VERSION"
  curl -fsSL -o "$WORK/ipxe.tar.gz" "https://github.com/ipxe/ipxe/archive/refs/tags/v${IPXE_VERSION}.tar.gz"
fi
mkdir -p "$WORK/ipxe"
tar -xzf "$WORK/ipxe.tar.gz" -C "$WORK/ipxe" --strip-components=1
cd "$WORK/ipxe/src"

echo "[ipxe] applying binutils-2.42 patch"
patch -p1 -f < "$REPO_ROOT/scripts/sources/ipxe-gas242-binutils.patch"

# config/local/console.h is written per-phase below: CONSOLE_SERIAL for BIOS
# (SeaBIOS has no serial console), empty for UEFI (OVMF already writes serial —
# a second serial writer doubles every character on the UEFI console).
# config/local/general.h enables the HTTPS download protocol (default iPXE has
# it #undef'd), which the TLS-only asset server requires.
mkdir -p config/local
cat > config/local/general.h <<'EOF'
#define DOWNLOAD_PROTO_HTTPS
EOF

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
bios_targets=""
efi_targets=""
artifacts=()
gen_iso=0 gen_usb=0

add_bios() { bios_targets="$bios_targets $1"; }
add_efi() { efi_targets="$efi_targets $1"; }

IFS=',' read -ra FMT <<< "$FORMATS"
for f in "${FMT[@]}"; do
  case "$f" in
    release)
      add_bios "bin/undionly.kpxe"; add_bios "bin/ipxe.pxe"
      add_efi "bin-x86_64-efi/ipxe.efi"
      artifacts+=("bin/undionly.kpxe:uponlan.xyz-undionly.kpxe")
      artifacts+=("bin/ipxe.pxe:uponlan.xyz.kpxe")
      artifacts+=("bin-x86_64-efi/ipxe.efi:uponlan.xyz.efi")
      ;;
    legacy)
      add_bios "bin/ipxe.kpxe"; add_bios "bin/ipxe.dsk"; add_bios "bin/ipxe.pdsk"; add_bios "bin/ipxe.lkrn"; add_bios "bin/undionly.kpxe"
      artifacts+=("bin/ipxe.kpxe:uponlan.xyz.kpxe")
      artifacts+=("bin/ipxe.dsk:uponlan.xyz.dsk")
      artifacts+=("bin/ipxe.pdsk:uponlan.xyz.pdsk")
      artifacts+=("bin/ipxe.lkrn:uponlan.xyz.lkrn")
      artifacts+=("bin/undionly.kpxe:uponlan.xyz-undionly.kpxe")
      ;;
    efi)
      add_efi "bin-x86_64-efi/ipxe.efi"; add_efi "bin-x86_64-efi/snp.efi"; add_efi "bin-x86_64-efi/snponly.efi"
      artifacts+=("bin-x86_64-efi/ipxe.efi:uponlan.xyz.efi")
      artifacts+=("bin-x86_64-efi/snp.efi:uponlan.xyz-snp.efi")
      artifacts+=("bin-x86_64-efi/snponly.efi:uponlan.xyz-snponly.efi")
      ;;
    iso) gen_iso=1 ;;
    usb) gen_usb=1 ;;
    *) echo "ERROR: unknown format '$f' (expected release|legacy|efi|iso|usb)" >&2; exit 1 ;;
  esac
done

# ISO/USB images are built by genfsimg from the lkrn (BIOS) + efi (UEFI) binaries.
if [ "$gen_iso" = 1 ] || [ "$gen_usb" = 1 ]; then
  add_bios "bin/ipxe.lkrn"
  add_efi "bin-x86_64-efi/ipxe.efi"
fi

# shellcheck disable=SC2086
# iPXE is C99-era code; gcc 14/15 defaults to C23, which (a) makes `()` mean
# "no args" instead of "unspecified args" (breaking the DRIVER() macro's
# two-arg callbacks) and (b) promotes several legacy-C warnings to hard errors.
# Pin the old standard and downgrade those warnings back (the general -Wno-error
# does NOT affect them in gcc 14+).
EXTRA_CFLAGS_VAL="-std=gnu11 -Wno-error=implicit-function-declaration -Wno-error=int-conversion -Wno-error=incompatible-pointer-types -Wno-error=implicit-int"

# Optional HTTPS trust material, embedded into the ROMs at build time so iPXE can
# verify the server certificate (and present a client cert when set). Unset by
# default: iPXE then boots over plain HTTP on the trusted LAN. TRUST takes a PEM
# of CA cert(s); CERT an optional client cert; paths are relative to the build
# host/container. Set both (or either) env vars to bake trust into the ROMs.
SSL_ARGS=""
for v in TRUST CERT; do
  val="${!v:-}"
  if [[ -n "$val" ]]; then
    [[ -f "$val" ]] || { echo "ERROR: $v file not found: $val" >&2; exit 1; }
    SSL_ARGS+=" $v=$val"
  fi
done

# Phase 1: BIOS with a serial console (SeaBIOS has no serial output of its own).
if [ -n "$bios_targets" ]; then
  echo "[ipxe] building BIOS (serial):$bios_targets"
  printf '#define CONSOLE_SERIAL\n' > config/local/console.h
  make -j"$(nproc)" $bios_targets EMBED="$WORK/embed.ipxe" NO_WERROR=1 EXTRA_CFLAGS="$EXTRA_CFLAGS_VAL" $SSL_ARGS
fi

# Phase 2: UEFI WITHOUT a serial console — OVMF already redirects its console to
# the serial port, and a second (iPXE) serial writer doubles every character.
if [ -n "$efi_targets" ]; then
  echo "[ipxe] building UEFI (no serial):$efi_targets"
  : > config/local/console.h
  make -j"$(nproc)" $efi_targets EMBED="$WORK/embed.ipxe" NO_WERROR=1 EXTRA_CFLAGS="$EXTRA_CFLAGS_VAL" $SSL_ARGS
fi

mkdir -p "$OUT_ROM"
for pair in "${artifacts[@]}"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  cp "$src" "$OUT_ROM/$dst"
done

if [ "$gen_iso" = 1 ]; then
  echo "[ipxe] generating ISO"
  "$REPO_ROOT/scripts/sources/genfsimg" -o "$OUT_ROM/uponlan.xyz.iso" \
    bin-x86_64-efi/ipxe.efi bin/ipxe.lkrn
fi
if [ "$gen_usb" = 1 ]; then
  echo "[ipxe] generating USB image"
  "$REPO_ROOT/scripts/sources/genfsimg" -o "$OUT_ROM/uponlan.xyz.img" \
    bin-x86_64-efi/ipxe.efi bin/ipxe.lkrn
fi

echo "[ipxe] done -> $OUT_ROM"
