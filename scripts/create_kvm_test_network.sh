#!/bin/bash
set -e

# KVM network name
if [ -z "$1" ]; then
    read -p "Which network do you want to create? [uponlan]: " network_name
    network_name=${network_name:-"uponlan"}
    echo "Creating network: $network_name"
else
    network_name=$1
    echo "Using network: $network_name"
fi

# TFTP vs UEFI HTTP Boot 
if [ -z "$2" ]; then
    read -p "Which type of TFTP do you want to create <local|uponlan|netboot|uefi.http> ? [uponlan]: " pxe_type
    pxe_type=${pxe_type:-"uponlan"}  # local or uponlan or netboot or uefi.http
    echo "Applying network config: $pxe_type"
else
    pxe_type=$2
    echo "Applying network config: $pxe_type"
fi

# Default vars
interface=${network_name}-br0        # The bridge interface to use for the network
network_ip=${network:-"192.168.7.0"} # Default network frame
gateway_ip="${network_ip%.*}.1"
tftp_server_ip=${tftp_server_ip:-$(hostname -I | awk '{print $1}')}

# List all VMs attached to the 'uponlan' network and remove them
for vm in $(sudo virsh list --all --name); do
  if sudo virsh domiflist "$vm" | grep -qw ${network_name}; then
    echo -e "\nUndefining and destroy VM: $vm\n"
    sudo virsh destroy "$vm" 2>/dev/null || true
    sudo virsh undefine "$vm" --remove-all-storage
  fi
  sleep 2
done

# cleanup network before to reapply
sudo virsh net-destroy ${network_name} 2> /dev/null || true
sudo virsh net-undefine ${network_name} 2> /dev/null || true

if [ "$pxe_type" == "local" ]; then
##### TFTP own by kvm (located on the kvm host) ####
cat <<EOF > /etc/libvirt/qemu/networks/${network_name}.xml
<network xmlns:dnsmasq="http://libvirt.org/schemas/network/dnsmasq/1.0">
  <name>${network_name}</name>
  <forward mode='nat'/>
  <bridge name="${interface}" stp="on" delay="5"/>
  <ip address="${gateway_ip}" netmask="255.255.255.0">
    <dhcp>
      <range start="${network_ip%.*}.128" end="${network_ip%.*}.254"/>
    </dhcp>
  </ip>
  <dnsmasq:options>
    <dnsmasq:option value="enable-tftp"/>
    <dnsmasq:option value="tftp-root=/var/lib/tftpboot"/>
    <dnsmasq:option value="dhcp-boot=undionly.0"/>
  </dnsmasq:options>
</network>
EOF
elif [ "$pxe_type" == "uponlan" ] || [ "$pxe_type" == "netboot" ]; then
##### UpOnLAN or Netboot config ####
cat <<EOF > /etc/libvirt/qemu/networks/${network_name}.xml
<network xmlns:dnsmasq='http://libvirt.org/schemas/network/dnsmasq/1.0'>
  <name>${network_name}</name>
  <forward mode='nat'/>
  <bridge name='${interface}' stp='on' delay='0'/>
  <domain name="test"/>
  <ip address='${gateway_ip}' netmask="255.255.255.0">
    <dhcp>
      <range start="${network_ip%.*}.128" end="${network_ip%.*}.254"/>
    </dhcp>
  </ip>
  <dnsmasq:options>
    <!-- Disable re-use of the DHCP servername and filename fields -->
    <dnsmasq:option value='dhcp-no-override'/>
    <!-- Detect iPXE requests -->
    <dnsmasq:option value='dhcp-match=set:ipxe-bios,175,33'/>
    <dnsmasq:option value='dhcp-match=set:ipxe-efi,175,36'/>
    <!-- UEFI/OVMF firmware matches option 93 (arch 7 = x86-64 UEFI); without
         this dhcp-boot it gets no option-67 bootfile and loops on DHCP -->
    <dnsmasq:option value='dhcp-match=set:uefi-fw,93,7'/>
    <dnsmasq:option value='dhcp-boot=tag:uefi-fw,rom/ipxe/${pxe_type}.xyz.efi,,${tftp_server_ip}'/>
    <dnsmasq:option value='dhcp-option=tag:uefi-fw,67,rom/ipxe/${pxe_type}.xyz.efi'/>
    <!-- NOTE: no pxe-service/pxe-prompt lines — dnsmasq's PXE processing
         (triggered only by those) injects option 60 "PXEClient" + option 43
         into every offer, which makes EDK2/OVMF abort with PXE-E21 before any
         TFTP. dhcp-boot tags cover every client: UEFI firmware and iPXE. -->
    <!-- iPXE services for initial boot -->
    <dnsmasq:option value='dhcp-boot=tag:ipxe-bios,rom/ipxe/${pxe_type}.xyz.kpxe,,${tftp_server_ip}'/>
    <dnsmasq:option value='dhcp-boot=tag:ipxe-efi,rom/ipxe/${pxe_type}.xyz.efi,,${tftp_server_ip}'/>
  </dnsmasq:options>
</network>
EOF
elif [ "$pxe_type" == "uefi.http" ] || [ "$pxe_type" == "efi.http" ]; then
##### UEFI HTTP Boot (no TFTP needed; firmware fetches the bootloader over HTTP) ####
cat <<EOF > /etc/libvirt/qemu/networks/${network_name}.xml
<network xmlns:dnsmasq='http://libvirt.org/schemas/network/dnsmasq/1.0'>
  <name>${network_name}</name>
  <forward mode='nat'/>
  <bridge name='${interface}' stp='on' delay='0'/>
  <ip address='${gateway_ip}' netmask='255.255.255.0'>
    <dhcp>
      <range start='${network_ip%.*}.128' end='${network_ip%.*}.254'/>
    </dhcp>
  </ip>
  <dnsmasq:options>
    <dnsmasq:option value='dhcp-vendorclass=set:efi-http,HTTPClient:Arch:00016'/>
    <dnsmasq:option value='dhcp-option-force=tag:efi-http,60,HTTPClient'/>
    <!-- UEFI firmware fetches the UpOnLAN bootloader straight from nginx -->
    <dnsmasq:option value='dhcp-boot=tag:efi-http,&quot;http://${tftp_server_ip}:${NGINX_PORT:-8080}/rom/ipxe/uponlan.xyz.efi&quot;'/>
  </dnsmasq:options>
</network>
EOF
else
  echo "Invalid pxe_type: $pxe_type (use local|uponlan|netboot|uefi.http)"
  exit 1
fi

# Precondition check: warn when the bootloader the network advertises does not exist
check_boot_files () {
    # expected file(s) that the PXE config references, relative to the serving root
    case "$pxe_type" in
        local)     local files="/var/lib/tftpboot/undionly.0" root="KVM host";;
        uponlan|netboot) local files="/config/menus/rom/ipxe/${pxe_type}.xyz-undionly.kpxe /config/menus/rom/ipxe/${pxe_type}.xyz.kpxe /config/menus/rom/ipxe/${pxe_type}.xyz.efi" root="container";;
        uefi.http|efi.http) local files="/config/menus/rom/ipxe/uponlan.xyz.efi" root="container";;
    esac

    for f in $files; do
        if [ "$root" == "container" ]; then
            cid=$(sudo podman ps --filter ancestor=localhost/uponlan:latest --format "{{.ID}}" | head -n1)
            if [ -z "$cid" ]; then
                echo -e "\nWARN: container not running — cannot check $f. Deploy first: ./wakemeup.sh -a deploy"
                return 0
            fi
            if sudo podman exec "$cid" test -f "$f"; then
                echo -e "\nOK: $f present in container (${root})"
            else
                echo -e "\nWARN: $f NOT found in container — run the ROM build (webapp Build tab or ansible) first, otherwise PXE boot will fail."
            fi
        else
            if [ -f "$f" ]; then
                echo -e "\nOK: $f present on ${root}"
            else
                echo -e "\nWARN: $f NOT found on ${root} — see docs/iPXE.md to install the iPXE binary."
            fi
        fi
    done
}

check_boot_files

sudo virsh net-define /etc/libvirt/qemu/networks/${network_name}.xml
sudo virsh net-start ${network_name}
sudo virsh net-autostart ${network_name}
sudo virsh net-list --all

echo -e "\nNetwork ${network_name} created in KVM on range ${network_ip}/24 - bridge name: ${interface}\n"