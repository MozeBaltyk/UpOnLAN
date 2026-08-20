#!/bin/bash
set -e
OS=rocky
VERSION=8
ARCHS="x86_64,aarch64"
BUILD_TYPE="direct_file"
EXTRACTS="\
https://dl.rockylinux.org/pub/rocky/${VERSION}/BaseOS/REPLACE_ARCH/os/images/pxeboot/vmlinuz|vmlinuz
https://dl.rockylinux.org/pub/rocky/${VERSION}/BaseOS/REPLACE_ARCH/os/images/pxeboot/initrd.img|initrd"