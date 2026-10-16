#!/bin/bash
set -euo pipefail

##############
#
# This script will set the required kernel network settings to 
# allow broadcast traffic to be sent from a docker network
# to another network.
# 
# This sets using both "sysctl -w" as well as configuring a file in
# "/etc/sysctl.d/" so the change will persist a reboot. 
#
##############

# The name of the network the docker container will be connected to
DOCKER_NETWORK=backend

# Find the subnet for the docker network
subnet=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$DOCKER_NETWORK")
if [ -z "$subnet" ] || [ "$subnet" = '<no value>' ]; then
    echo "Could not determine the subnet for $DOCKER_NETWORK" >&2
    exit 1
fi

echo "Got subnet $subnet"
read -r _ _ interface _ < <(ip -o route show "$subnet") || true
if [ -z "${interface:-}" ]; then
    echo "Could not determine the network interface for $subnet" >&2
    exit 1
fi
echo "Got interface $interface"

# Make no host changes until both Docker and route discovery have succeeded.
sudo sysctl -w net.ipv4.icmp_echo_ignore_broadcasts=0
sudo sysctl -w net.ipv4.conf.all.bc_forwarding=1
sudo sysctl -w "net.ipv4.conf.${interface}.bc_forwarding=1"
{
    echo '# Allow broadcast forwarding from the Docker network'
    echo 'net.ipv4.icmp_echo_ignore_broadcasts=0'
    echo 'net.ipv4.conf.all.bc_forwarding=1'
    echo "net.ipv4.conf.${interface}.bc_forwarding=1"
} | sudo tee /etc/sysctl.d/97-docker-broadcast.conf >/dev/null
