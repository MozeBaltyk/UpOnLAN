#!/bin/bash
set -e

vmname="testpxe"

if [ -z "$1" ]; then
    read -p "Which network do you want to use? [uponlan]: " network
    network=${network:-"uponlan"}
    echo "Using network: $network"
else
    network=$1
    echo "Using network: $network"
fi

if ! sudo virsh net-info "$network" &>/dev/null; then
    echo "Network '$network' does not exist. Please create it first."
    exit 1
fi

if sudo virsh list --all --name | grep -wq "$vmname"; then
    echo -e "\nVM '$vmname' already exists. Please check the console in Virt-Manager.\n"
else
    echo -e "\n\n##### Creating a test VM #####\n"
    sudo virt-install --connect qemu:///system \
    --name ${vmname} \
    --network=network=${network} --pxe \
    --ram=2048 \
    --vcpus=2 \
    --os-variant=rhl8.0 \
    --disk path=/var/lib/libvirt/images/${vmname}.qcow2,size=40 \
    --noautoconsole
    echo -e "\n\n- Test VM created. Please check the console in Virt-Manager.\n"
fi
