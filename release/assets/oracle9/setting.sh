#!/bin/bash
set -e
OS=oracle
VERSION=9
ARCHS="x86_64,aarch64"
RELEASE=$(curl -sL http://mirrors.kernel.org/oracle/OL9/ | awk -F '(href="|/">)' '/="u/ {print $2}' | awk -F'u' '{print $2}'| tail -n 1)
URL="http://mirrors.kernel.org/oracle/OL9/u${RELEASE}/REPLACE_ARCH/OracleLinux-R9-U${RELEASE}-REPLACE_ARCH-dvd.iso"   
BUILD_TYPE="iso_extraction"
EXTRACTS="\
isolinux/initrd.img|initrd
isolinux/vmlinuz|vmlinuz
images/install.img|squashfs.img"
