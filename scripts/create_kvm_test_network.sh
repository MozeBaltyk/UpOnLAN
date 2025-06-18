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
    <!-- PXE discovery control (vendor option) -->
    <dnsmasq:option value='dhcp-option=vendor:PXEClient,6,2b'/>
    <!-- Detect iPXE requests -->
    <dnsmasq:option value='dhcp-match=set:ipxe-bios,175,33'/>
    <dnsmasq:option value='dhcp-match=set:ipxe-efi,175,36'/>
    <!-- PXE services for initial boot (not iPXE) -->
    <dnsmasq:option value='pxe-service=tag:!ipxe-ok,X86PC,PXE,rom/${pxe_type}.xyz-undionly.kpxe'/>
    <dnsmasq:option value='pxe-service=tag:!ipxe-ok,BC_EFI,PXE,rom/${pxe_type}.xyz.efi'/>
    <dnsmasq:option value='pxe-service=tag:!ipxe-ok,X86-64_EFI,PXE,rom/${pxe_type}.xyz.efi'/>
    <!-- iPXE services for initial boot -->
    <dnsmasq:option value='dhcp-boot=tag:ipxe-bios,${pxe_type}.xyz.kpxe,,rom/${tftp_server_ip};'/>
    <dnsmasq:option value='dhcp-boot=tag:ipxe-efi,${pxe_type}.xyz.efi,,rom/${tftp_server_ip};'/>
  </dnsmasq:options>
</network>
EOF
elif pxe_type == "efi.http"; then
##### UEFI HTTP Boot (request extra package for kvm: ) ####
cat <<EOF > /etc/libvirt/qemu/networks/${network_name}.xml
<network xmlns:dnsmasq='http://libvirt.org/schemas/network/dnsmasq/1.0'>
  <name>${network_name}</name>
  <forward mode='nat'/>
  <bridge name='${interface}' stp='on' delay='0'/>
  <ip address='${gateway_ip}' netmask='255.255.255.0'>
  <tftp root='/var/lib/tftpboot'/>
    <dhcp>
      <range start='${network_ip%.*}.128' end='${network_ip%.*}.254' />
      <bootp file='pxelinux.0'/>
    </dhcp>
  </ip>
  <dnsmasq:options>
    <dnsmasq:option value='dhcp-vendorclass=set:efi-http,HTTPClient:Arch:00016'/>
    <dnsmasq:option value='dhcp-option-force=tag:efi-http,60,HTTPClient'/>
    <dnsmasq:option value='dhcp-boot=tag:efi-http,&quot;http://192.168.122.1/rhel8/EFI/BOOT/BOOTX64.EFI&quot;'/>
  </dnsmasq:options>
</network>
EOF
else
  echo "nothing"
fi

sudo virsh net-define /etc/libvirt/qemu/networks/${network_name}.xml
sudo virsh net-start ${network_name}
sudo virsh net-autostart ${network_name}
sudo virsh net-list --all

echo -e "\nNetwork ${network_name} created in KVM on range ${network_ip}/24 - bridge name: ${interface}\n"