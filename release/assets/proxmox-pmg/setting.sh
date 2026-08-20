#!/bin/bash
set -e
OS=proxmox
VERSION=pmg-8.2-1
ARCHS="amd64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/netbootxyz/asset-mirror/releases/download/8.2-1-8374c64d/vmlinuz|vmlinuz
https://github.com/netbootxyz/asset-mirror/releases/download/8.2-1-8374c64d/initrd|initrd
https://github.com/netbootxyz/asset-mirror/releases/download/8.2-1-8374c64d/proxmox.iso|proxmox.iso"
