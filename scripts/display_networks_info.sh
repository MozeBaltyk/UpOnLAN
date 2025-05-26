#!/bin/bash
set -e

######### OS Information #########
echo -e "\n##### Systems Networks #####\n"
read _ _ gateway _ < <(ip route list match 0/0); 
echo "Default Gateway: $gateway"
first_ip=$(ip route get 1 | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')
echo "First IP in the routing table: $first_ip"

######### Podman Networks #########
echo -e "\n##### Podman Networks #####\n"
podman_networks=$(sudo podman network ls 2> /dev/null)
echo -e "Available Podman networks:\n\n$podman_networks"
echo -e "\n"
uponlan_network=$(sudo podman pod inspect $(sudo podman pod ps --filter name=uponlan --format "{{.ID}}") | jq -r ".InfraConfig.Networks[]")
echo -e "Pod \033[1;34muponlan\033[0m is using network:  \033[1;34m$uponlan_network\033[0m\n"
sudo podman network inspect ${uponlan_network} | jq -r ".[].subnets[]"

######### KVM Networks #########
echo -e "\n##### KVM networks #####\n"
kvm_system_networks_all=$(sudo virsh net-list --all)
echo -e "Available KVM networks in qemu:///system :\n$kvm_system_networks_all"
for net in $(sudo virsh net-list --name); do
    bridge_name=$(sudo virsh net-info --network ${net} | grep Bridge | cut -d":" -f2 | sed 's/^[[:space:]]*//')
    for br in ${bridge_name}; do
        br_info=$(ip -br -c address show dev ${br} || echo "No IP address assigned to bridge ${br}")
    done
    echo -e "\n\033[1;34m${net}\033[0m have the Bridge: $br_info"
done
echo -e "\n"
