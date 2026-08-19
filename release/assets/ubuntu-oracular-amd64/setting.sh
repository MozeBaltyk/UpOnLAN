#!/bin/bash
set -e
OS=ubuntu
VERSION=oracular
ARCHS="amd64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/netbootxyz/ubuntu-squash/releases/download/24.10-fcf8807c/vmlinuz|vmlinuz
https://github.com/netbootxyz/ubuntu-squash/releases/download/24.10-fcf8807c/initrd|initrd"
