#!/bin/bash
set -e

# verify_kvm_boot.sh <network_name> [vm_name] [pxe_type] [timeout_seconds]
#
# Verifies a PXE boot attempt end-to-end against the UpOnLAN container:
#   1. VM exists and is running
#   2. VM obtained a DHCP lease on the test network
#   3. Container TFTP log shows the VM fetching the iPXE bootloader
#   4. Container nginx access log shows the VM fetching the menu over HTTP
# Exits 0 on success, 1 on failure. Use after scripts/create_kvm_test_vm.sh.
#
# NOTE: the container is reached through podman port forwarding, so the source
# IP seen in the logs is the podman gateway (10.89.0.x), NOT the VM's IP.
# We therefore grep for the boot-file name, which is NAT-proof.

network_name=${1:-uponlan}
vm_name=${2:-testpxe}
pxe_type=${3:-uponlan}
timeout=${4:-90}

# boot file token to search for in the logs (differs per pxe_type)
case "$pxe_type" in
    local)     token="undionly.0";;
    uefi.http|efi.http) token="uponlan.xyz.efi";;
    *)         token="${pxe_type}.xyz";;
esac

log () { echo -e "[verify] $*"; }

# --- 1. VM running? ---
if ! sudo virsh list --name | grep -qw "$vm_name"; then
    log "FAIL: VM '$vm_name' is not running (check 'virsh list --all')"
    exit 1
fi
log "OK: VM '$vm_name' is running"

# --- 2. DHCP lease ---
log "Waiting up to ${timeout}s for a DHCP lease on '$network_name'..."
vm_ip=""
for i in $(seq 1 $((timeout / 2))); do
    # net-dhcp-leases: Expiry Time, MAC, Protocol, IP, Hostname, Client ID
    vm_ip=$(sudo virsh net-dhcp-leases "$network_name" 2>/dev/null | awk 'NR>2 && $4=="ipv4" {print $5; exit}' | cut -d/ -f1)
    [ -n "$vm_ip" ] && break
    sleep 2
done

if [ -z "$vm_ip" ]; then
    log "FAIL: no DHCP lease after ${timeout}s — DHCP/PXE discovery (step 1) failed"
    log "       Check the network: 'virsh net-dumpxml $network_name'"
    exit 1
fi
log "OK: lease obtained, VM IP is $vm_ip"

# --- 3 & 4. TFTP + HTTP traffic in the container logs ---
cid=$(sudo podman ps --filter ancestor=localhost/uponlan:latest --format "{{.ID}}" | head -n1)
if [ -z "$cid" ]; then
    log "FAIL: UpOnLAN container not running — cannot check boot traffic. Deploy first: ./wakemeup.sh -a deploy"
    exit 1
fi

log "Watching container logs for '$token' (NAT source, so matching by file name)..."
tftp_hits=0
http_hits=0
for i in $(seq 1 $((timeout / 2))); do
    tftp_hits=$(sudo podman exec "$cid" sh -c "grep -c '$token' /logs/tftp/tftpd.log 2>/dev/null || true" | tr -d '[:space:]')
    http_hits=$(sudo podman exec "$cid" sh -c "grep -c '$token' /logs/nginx/access.log 2>/dev/null || true" | tr -d '[:space:]')
    [ "${tftp_hits:-0}" -gt 0 ] && [ "${http_hits:-0}" -gt 0 ] && break
    sleep 2
done

[ "${tftp_hits:-0}" -gt 0 ] && log "OK: TFTP served '$token' ($tftp_hits hit(s))" \
                            || log "WARN: no '$token' request in /logs/tftp/tftpd.log"
[ "${http_hits:-0}" -gt 0 ] && log "OK: nginx served '$token' ($http_hits hit(s))" \
                            || log "WARN: no '$token' request in /logs/nginx/access.log"

# --- verdict ---
if [ "${tftp_hits:-0}" -gt 0 ] && [ "${http_hits:-0}" -gt 0 ]; then
    log "PASS: full boot chain reached UpOnLAN (DHCP -> TFTP -> HTTP)"
    exit 0
fi
if [ "${tftp_hits:-0}" -gt 0 ] || [ "${http_hits:-0}" -gt 0 ]; then
    log "PARTIAL: boot started but did not complete the chain"
    exit 1
fi
log "FAIL: no boot traffic reached UpOnLAN — VM got a lease but never contacted the container"
log "       Check the Monitor tab, or 'virsh screenshot $vm_name' to see the VM state"
exit 1
