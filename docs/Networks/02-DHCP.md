## 📡 DHCP configuration insights

The first step of every iPXE boot is: **DHCP assigns an IP and the iPXE chainload path** (step 1️⃣ of [Networks summary](Networks/01-Overview.md)).

Two knobs matter:

- `next-server` — IP of the host serving the iPXE binary (TFTP).
- `filename` — the iPXE binary to load (`undionly.0` / `undionly.kpxe` for BIOS, `ipxe.efi` for UEFI).

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
dhcp-boot=undionly.0,192.168.122.1
```

| Key | Meaning |
|-----|---------|
| `enable-tftp` | Serve the iPXE binary over TFTP |
| `tftp-root` | Where the iPXE binaries live (see [iPXE Quick Start](iPXE/01-Quick-Start.md)) |
| `dhcp-boot=undionly.0,192.168.122.1` | `filename` + `next-server` in one line |

Once iPXE is loaded it fetches the menu over HTTP(S) from the UpOnLAN webapp (step 3️⃣).

---

## ⚠️ One TFTP per network

TFTP is bound to UDP port **69** — only one TFTP server can run on a given host/interface at a time.

> If you tested a local KVM dnsmasq TFTP config and left it running, it will conflict with the UpOnLAN webapp container, which also listens on port 69. Stop the local dnsmasq TFTP before deploying UpOnLAN.

---

## 🧭 ProxyDHCP

iPXE supports **ProxyDHCP**: the existing corporate DHCP keeps handing out IPs as usual, and a second DHCP server only advertises the boot file (`dhcp-boot` / options 66-67) without answering the address request (`dhcp-range` omitted). Clients get an IP from the main server and the PXE pointer from the proxy. This is how UpOnLAN can provide boot files on a network whose DHCP is not controlled by you.

```bash
# dnsmasq as a *proxy* DHCP: no dhcp-range → no address is leased
interface=eth0
enable-tftp
tftp-root=/var/lib/tftpboot
dhcp-boot=undionly.0
```

The bootloader wrapper documented in [ROM Build](iPXE/03-ROM-Build.md) handles ProxyDHCP detection automatically (`proxydhcp-next-server` fallback).

---

## 📚 More Resources

- 📘 [iPXE DHCP documentation](https://ipxe.org/howto/dhcpd)
- 📘 [dnsmasq man page](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
