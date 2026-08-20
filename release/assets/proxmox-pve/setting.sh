#!/bin/bash
set -e
OS=proxmox
VERSION=ve-8.4-1
ARCHS="amd64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/netbootxyz/asset-mirror/releases/download/8.4-1-613c19ff/vmlinuz|vmlinuz
https://github.com/netbootxyz/asset-mirror/releases/download/8.4-1-613c19ff/initrd|initrd
https://github.com/netbootxyz/asset-mirror/releases/download/8.4-1-613c19ff/proxmox.iso|proxmox.iso"
