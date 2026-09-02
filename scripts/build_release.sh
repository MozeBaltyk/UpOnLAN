#!/usr/bin/env bash
# Build the local release pipeline in dependency order:
#
#   1. scripts/release_assets.sh     - mirror the boot assets (incremental)
#   2. scripts/release_menu.sh       - pack menus.tar.gz (no ROMs — they are
#                                      built at deploy time by init.sh, so the
#                                      tarball ships menus + provisioning only)
#
# iPXE ROMs are deliberately NOT built here: they must embed the deployment's
# TLS cert, which only exists at deploy time. init.sh builds them into the TFTP
# root on first boot; the webapp Build UI does the same on demand.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The menu version lives in release/menus/version.ipxe, independent of the
# webapp version (src/webapp/package.json). An explicit arg overrides it.
MENU_VERSION="${1:-$(sed -n 's/^set menu_version //p' release/menus/version.ipxe)}"
echo "### build_release.sh: menu version ${MENU_VERSION} ###"

bash scripts/release_assets.sh
bash scripts/release_menu.sh "$MENU_VERSION"

echo "### build_release.sh done -> release/output/menu/${MENU_VERSION}/menus.tar.gz ###"