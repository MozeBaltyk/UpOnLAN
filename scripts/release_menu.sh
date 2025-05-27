#!/bin/bash
set -e

if [[ $# -ne 1 ]]; then 
echo "Usage: $0 <hard_release_version>"
exit 1; 
fi

HARD_RELEASE=$1

echo -e "\n### Releasing menu version ${HARD_RELEASE} ###\n"


pwd 
ls 
ls ./release/menus
mkdir -p ./release/githubout

# Set Version
sed -i -e "s/set menu_version .*$/set menu_version ${HARD_RELEASE}/" ./release/menus/version.ipxe

# ipxe Artefacts
mv ./release/menus/ipxe/* ./release/githubout/ 2> /dev/null || true

# tar all Menus Artefacts
tar -czf menus.tar.gz -C ./release/menus .
mv menus.tar.gz release/githubout/.
