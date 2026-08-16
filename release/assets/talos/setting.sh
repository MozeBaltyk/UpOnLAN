#!/bin/bash
set -e
VERSION=$(curl --silent "https://api.github.com/repos/siderolabs/talos/releases/latest" | jq -r .tag_name)
OS=talos
RELEASE=${VERSION#v}
ARCHS="amd64,arm64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/siderolabs/talos/releases/download/${VERSION}/vmlinuz-REPLACE_ARCH|vmlinuz
https://github.com/siderolabs/talos/releases/download/${VERSION}/initramfs-REPLACE_ARCH.xz|initrd"