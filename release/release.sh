#!/bin/bash
set -e

if [[ $# -ne 1 ]]; then exit 1; fi

HARD_RELEASE=$1

mkdir -p githubout

# ipxe Artefacts
mv menus/ipxe/* githubout/ 2> /dev/null || true

# Menu Artefacts
sed -i -e "s/set menu_version .*$/set menu_version ${HARD_RELEASE}/" release/menus/version.ipxe
tar -czf menus.tar.gz release/menus/*
mv menus.tar.gz release/githubout

# Assets Artefacts
