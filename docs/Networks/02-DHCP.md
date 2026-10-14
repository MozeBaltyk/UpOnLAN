## 📡 DHCP configuration insights

The first step of every iPXE boot is: **DHCP assigns an IP and the iPXE chainload path** (step 1️⃣ of [Networks summary](Networks/01-Overview.md)).

Two knobs matter:

- `next-server` — IP of the host serving the iPXE binary (TFTP).
- `filename` — the deployed iPXE binary: `rom/ipxe/uponlan.xyz-undionly.kpxe` for BIOS,
  `rom/ipxe/uponlan.xyz.efi` for x86_64 UEFI (verify installed files first).

That pair is the legacy option **66 + 67**. Most DHCP servers also expose them as `next-server` / `filename`.

---

## 🐧 dnsmasq (KVM)

`dnsmasq` is the DHCP server already bundled with KVM. A minimal config to netboot clients:

```bash
# /etc/dnsmasq.conf
interface=virbr0

# DHCP range and gateway
dhcp-range=192.168.122.10,192.168.122.200,12h
dhcp-option=3,192.168.122.1

# iPXE chainload (step 2️⃣: TFTP loads the iPXE binary)
enable-tftp
tftp-root=/var/lib/tftpboot
dhcp-match=set:efi64,option:client-arch,7
dhcp-match=set:efi64,option:client-arch,9
dhcp-boot=tag:!efi64,rom/ipxe/uponlan.xyz-undionly.kpxe,,192.168.122.1
dhcp-boot=tag:efi64,rom/ipxe/uponlan.xyz.efi,,192.168.122.1
```

| Key | Meaning |
|-----|---------|
| `enable-tftp` | Serve the iPXE binary over TFTP |
| `tftp-root` | Where the iPXE binaries live (see [iPXE Quick Start](iPXE/01-Quick-Start.md)) |
| `dhcp-boot=…,filename,,server-IP` | `filename` + `next-server` (empty server-name field) |

Once iPXE is loaded it fetches the menu over HTTP(S) from the UpOnLAN.xyz webapp (step 3️⃣).

---

## ⚠️ One TFTP per network

TFTP is bound to UDP port **69** — only one TFTP server can run on a given host/interface at a time.

> If you tested a local KVM dnsmasq TFTP config and left it running, it will conflict with the UpOnLAN.xyz webapp container, which also listens on port 69. Stop the local dnsmasq TFTP before deploying UpOnLAN.xyz.

---

## 🧭 ProxyDHCP

iPXE supports **ProxyDHCP**: externally configured dnsmasq can advertise boot
options while the existing DHCP server leases addresses. UpOnLAN's bundled
dnsmasq is **TFTP-only**, not a DHCP/ProxyDHCP service. Arrange this externally
with network-owner approval; do not start a competing address server.

```bash
# Example external proxy on 192.168.122.0/24; adapt interface/subnet/server.
port=0
interface=eth0
dhcp-range=192.168.122.0,proxy,255.255.255.0
pxe-service=x86PC,"UpOnLAN BIOS",rom/ipxe/uponlan.xyz-undionly.kpxe,192.168.122.1
pxe-service=BC_EFI,"UpOnLAN UEFI BC",rom/ipxe/uponlan.xyz.efi,192.168.122.1
pxe-service=X86-64_EFI,"UpOnLAN UEFI",rom/ipxe/uponlan.xyz.efi,192.168.122.1
# TFTP already served by UpOnLAN; do not enable a second TFTP listener here.
```

Verify DHCP relay/architecture behavior on real firmware; this example is not
live acceptance. Use one-time PXE boot and local disk next boot for Agent installs.

---

## 📚 More Resources

- 📘 [iPXE DHCP documentation](https://ipxe.org/howto/dhcpd)
- 📘 [dnsmasq man page](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
