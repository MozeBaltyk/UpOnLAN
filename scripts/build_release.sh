#!/usr/bin/env bash
# Build the full release pipeline in dependency order:
#
#   1. scripts/build_ipxe_roms.sh   - build the iPXE ROMs (menu server + option ROM)
#   2. scripts/release_assets.sh     - mirror the boot assets (incremental)
#   3. scripts/release_menu.sh       - pack menus.tar.gz (REFUSES to run without the ROMs)
#
# Ordering is enforced twice: this script runs them in order, and
# release_menu.sh independently fails fast if the rom/ipxe artifacts are absent.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-$(jq -r '.version' src/webapp/package.json)}"
echo "### build_release.sh: version ${VERSION} ###"

bash scripts/build_ipxe_roms.sh
bash scripts/release_assets.sh
bash scripts/release_menu.sh "$VERSION"

echo "### build_release.sh done -> release/output/menu/${VERSION}/menus.tar.gz ###"