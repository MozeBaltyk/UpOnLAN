#!/bin/bash
set -e
VERSION=$(curl --silent "https://api.github.com/repos/harvester/harvester/releases/latest" | jq -r .tag_name)
OS=harvester
RELEASE=${VERSION#v}
ARCHS="amd64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://releases.rancher.com/harvester/${VERSION}/harvester-${VERSION}-vmlinuz-REPLACE_ARCH|vmlinuz
https://releases.rancher.com/harvester/${VERSION}/harvester-${VERSION}-initrd-REPLACE_ARCH|initrd
https://releases.rancher.com/harvester/${VERSION}/harvester-${VERSION}-rootfs-REPLACE_ARCH.squashfs|squashfs.img
https://releases.rancher.com/harvester/${VERSION}/harvester-${VERSION}-REPLACE_ARCH.sha512|harvester.sha512
https://releases.rancher.com/harvester/${VERSION}/version.yaml|version.yaml"
