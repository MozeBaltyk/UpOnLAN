#!/bin/bash
set -e

if [[ $# -ne 1 ]]; then 
echo "Usage: $0 <hard_release_version>"
exit 1; 
fi

HARD_RELEASE=$1

echo -e "\n### Releasing menu version ${HARD_RELEASE} ###\n"

mkdir -p ../release/githubout

# ipxe Artefacts
mv ../menus/ipxe/* ../release/githubout/ 2> /dev/null || true

# Menu Artefacts
sed -i -e "s/set menu_version .*$/set menu_version ${HARD_RELEASE}/" ../release/githubout/version.ipxe
tar -czf menus.tar.gz ../release/menus/*
mv menus.tar.gz release/githubout/.

# Assets Artefacts
