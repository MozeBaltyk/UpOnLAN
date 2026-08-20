#!/usr/bin/env bash
# Build the full release pipeline in dependency order:
#
#   1. scripts/build_ipxe_roms.sh   - build the iPXE ROMs (menu server + option ROM)
#   2. scripts/release_assets.sh     - mirror the boot assets (incremental)
#   3. scripts/release_menu.sh       - pack menus.tar.gz (warns if the rom/ipxe artifacts are absent)
#
# Ordering is enforced here (ROM build before menu). release_menu.sh only warns
# when the rom/ipxe artifacts are absent, so run it via this script for a full build.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The menu version lives in release/menus/version.ipxe, independent of the
# webapp version (src/webapp/package.json). An explicit arg overrides it.
MENU_VERSION="${1:-$(sed -n 's/^set menu_version //p' release/menus/version.ipxe)}"
echo "### build_release.sh: menu version ${MENU_VERSION} ###"

bash scripts/build_ipxe_roms.sh
bash scripts/release_assets.sh
bash scripts/release_menu.sh "$MENU_VERSION"

echo "### build_release.sh done -> release/output/menu/${MENU_VERSION}/menus.tar.gz ###"