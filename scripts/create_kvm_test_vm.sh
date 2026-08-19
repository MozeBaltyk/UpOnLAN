#!/bin/bash
set -e

vmname="testpxe"

if [ -z "$1" ]; then
    read -p "Which network do you want to use? [uponlan]: " network_name
    network_name=${network_name:-"uponlan"}
    echo "Using network: $network_name"
else
    network_name=$1
    echo "Using network: $network_name"
fi

# pxe_type drives the VM firmware: UEFI HTTP boot needs an OVMF/UEFI guest
if [ -z "$2" ]; then
    pxe_type="uponlan"
else
    pxe_type=$2
fi
echo "Using pxe_type: $pxe_type"

if ! sudo virsh net-info "$network_name" &>/dev/null; then
    echo "Network '$network_name' does not exist. Please create it first."
    exit 1
fi

boot_args=()
case "$pxe_type" in
    uefi.http|efi.http)
        if [ ! -f /usr/share/OVMF/OVMF_CODE.fd ] && ! ls /usr/share/OVMF/OVMF_CODE_*.fd &>/dev/null; then
            echo -e "\nERROR: UEFI HTTP boot requires OVMF firmware. Install it:"
            echo "  Debian/Ubuntu: sudo apt install ovmf"
            echo "  Fedora/RHEL:   sudo dnf install edk2-ovmf"
            exit 1
        fi
        boot_args=(--boot uefi)
        ;;
esac

if sudo virsh list --all --name | grep -wq "$vmname"; then
    echo -e "\nVM '$vmname' already exists. Please check the console in Virt-Manager.\n"
else
    echo -e "\n\n##### Creating a test VM #####\n"
    sudo virt-install --connect qemu:///system \
    --name ${vmname} \
    --network=network=${network_name} --pxe \
    --ram=2048 \
    --vcpus=2 \
    --os-variant=rhl8.0 \
    --disk path=/var/lib/libvirt/images/${vmname}.qcow2,size=40 \
    --serial pty --console pty,target_type=serial \
    --noautoconsole \
    "${boot_args[@]}"
    echo -e "\n\n- Test VM created. Please check the console in Virt-Manager.\n"
fi
