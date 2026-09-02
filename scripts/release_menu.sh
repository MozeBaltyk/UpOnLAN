#!/bin/bash
set -e

if [[ $# -ne 1 ]]; then 
echo "Usage: $0 <hard_release_version>"
exit 1; 
fi

HARD_RELEASE=$1

# The iPXE ROMs are intentionally NOT shipped in the menu tarball: they must
# embed the deployment's TLS cert, so init.sh builds them at deploy time (or the
# webapp Build UI does). Any rom/ipxe/* present in release/menus/ still gets
# bundled below, for operators who prebuild them locally, but the default
# release ships menus + provisioning profiles only.
echo -e "\n### Releasing menu version ${HARD_RELEASE} ###\n"
release_dir="./release/output/menu/${HARD_RELEASE}"
mkdir -p "$release_dir"

# Set Version
sed -i -e "s/set menu_version .*$/set menu_version ${HARD_RELEASE}/" ./release/menus/version.ipxe

# ipxe Artefacts
mv ./release/menus/ipxe/* "$release_dir"/ 2> /dev/null || true

# tar all Menus Artefacts + provisioning profiles. local-vars.ipxe is a
# per-deployment override (local mirror endpoint) and must never be baked into
# a shipped release. Provisioning profiles (release/provisioning/) ride in the
# same tarball under provisioning/ so the menu and its ks.cfg/cloud-init seeds
# ship and version together.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -r ./release/menus/. "$stage"/
rm -f "$stage/local-vars.ipxe"
if [ -d ./release/provisioning ]; then
  mkdir -p "$stage/provisioning"
  cp -r ./release/provisioning/. "$stage/provisioning"/
fi
tar -czf "$release_dir/menus.tar.gz" -C "$stage" .

# GitHub-like releases/latest response so the webapp's local endpoint browser
# (Menu From Endpoint URL) and dashboard resolve this version like a GitHub API.
echo "{\"tag_name\":\"${HARD_RELEASE}\"}" > ./release/output/menu/latest
