#!/bin/bash
set -e
OS=ubuntu
VERSION=oracular
ARCHS="aarch64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/netbootxyz/ubuntu-squash/releases/download/24.10-f22a7742/vmlinuz|vmlinuz
https://github.com/netbootxyz/ubuntu-squash/releases/download/24.10-f22a7742/initrd|initrd"
