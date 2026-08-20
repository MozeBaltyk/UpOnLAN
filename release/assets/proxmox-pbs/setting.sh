#!/bin/bash
set -e
OS=proxmox
VERSION=pbs-3.4-1
ARCHS="amd64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/netbootxyz/asset-mirror/releases/download/3.4-1-f308cf4b/vmlinuz|vmlinuz
https://github.com/netbootxyz/asset-mirror/releases/download/3.4-1-f308cf4b/initrd|initrd
https://github.com/netbootxyz/asset-mirror/releases/download/3.4-1-f308cf4b/proxmox.iso|proxmox.iso"
