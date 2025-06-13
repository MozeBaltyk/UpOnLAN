#!/bin/bash
set -e
OS=oracle
VERSION=8
ARCHS="x86_64"
RELEASE=$(curl -sL http://mirrors.kernel.org/oracle/OL8/ | awk -F '(href="|/">)' '/="u/ {print $2}' | awk -F'u' '{print $2}'| tail -n 1)
URL="http://mirrors.kernel.org/oracle/OL8/u${RELEASE}/REPLACE_ARCH/OracleLinux-R8-U${RELEASE}-REPLACE_ARCH-dvd.iso"
BUILD_TYPE="iso_extraction"
EXTRACTS="\
isolinux/initrd.img|initrd
isolinux/vmlinuz|vmlinuz
images/install.img|squashfs.img"
