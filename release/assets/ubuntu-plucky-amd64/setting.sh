#!/bin/bash
set -e
OS=ubuntu
VERSION=plucky
ARCHS="amd64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/netbootxyz/ubuntu-squash/releases/download/25.04-8094159e/vmlinuz|vmlinuz
https://github.com/netbootxyz/ubuntu-squash/releases/download/25.04-8094159e/initrd|initrd"
