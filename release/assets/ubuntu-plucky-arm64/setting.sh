#!/bin/bash
set -e
OS=ubuntu
VERSION=plucky
ARCHS="aarch64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://github.com/netbootxyz/ubuntu-squash/releases/download/25.04-e56e947a/vmlinuz|vmlinuz
https://github.com/netbootxyz/ubuntu-squash/releases/download/25.04-e56e947a/initrd|initrd"
