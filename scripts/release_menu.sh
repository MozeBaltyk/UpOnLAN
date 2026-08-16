#!/bin/bash
set -e

if [[ $# -ne 1 ]]; then 
echo "Usage: $0 <hard_release_version>"
exit 1; 
fi

HARD_RELEASE=$1

echo -e "\n### Releasing menu version ${HARD_RELEASE} ###\n"
release_dir="./release/output/releases/download/${HARD_RELEASE}"
mkdir -p "$release_dir"

# Set Version
sed -i -e "s/set menu_version .*$/set menu_version ${HARD_RELEASE}/" ./release/menus/version.ipxe

# ipxe Artefacts
mv ./release/menus/ipxe/* "$release_dir"/ 2> /dev/null || true

# tar all Menus Artefacts
tar -czf "$release_dir/menus.tar.gz" -C ./release/menus .

# GitHub-like releases/latest response so the webapp's local endpoint browser
# (Menu From Endpoint URL) and dashboard resolve this version like a GitHub API.
echo "{\"tag_name\":\"${HARD_RELEASE}\"}" > ./release/output/releases/latest
