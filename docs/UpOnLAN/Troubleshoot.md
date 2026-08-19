## 🔧 Troubleshooting UpOnLAN

Quick checks and fixes for the most common problems. All container operations go through `./wakemeup.sh`.

---

## 🚧 Webapp unreachable

1. Is the container running? `./wakemeup.sh -a logs` shows pod and container status.
2. Still down → `./wakemeup.sh -a logs` and look for a crash on startup.
3. Restart with `./wakemeup.sh -a redeploy` (rebuilds and re-creates the container).

**Ports used by UpOnLAN** — check nothing else occupies them:

| Port | Service |
|------|---------|
| 3000 | Node webapp (`WEB_APP_PORT`) |
| 8080 | Nginx reverse proxy (`NGINX_PORT`) |
| 69   | TFTP (UDP) |

> TFTP on port 69 is the classic conflict: any other TFTP server on the same host/interface (e.g. a leftover KVM `dnsmasq` config) will block it. See [DHCP insights](../Networks/DHCP.md).

---

## 🛑 PXE boot fails

Walk the boot steps from [Networks summary](../Networks.md):

| Step | Failure | Check |
|------|---------|-------|
| 1️⃣ DHCP assigns IP + iPXE path | No IP / no boot file offered | DHCP config (`next-server`/`filename`) — [DHCP insights](../Networks/DHCP.md) |
| 2️⃣ TFTP loads iPXE binary | TFTP timeout | Port 69 conflict; binaries present in `/var/lib/tftpboot` on the DHCP host |
| 3️⃣ iPXE fetches menu via HTTP(S) | Menu not found | Nginx up (port 8080); menu file exists in the editor; `/logs/nginx/` |
| 4️⃣ iPXE executes | Kernel/initrd 404 | Assets mirrored (Assets tab) and `endpoints.yml` points to the right URLs |

The webapp **Monitor** tab tails Nginx, TFTP and webapp activity in real time — it is the first place to look during a failed boot.

## 🧱 Menu build fails in the webapp

The webapp's Build button runs `scripts/build_ipxe_roms.sh` directly inside the container (no Ansible); logs land in `/logs/rom/build_*.log`. Use `./wakemeup.sh -a logs` or the Monitor tab to inspect the webapp and build output.

---

## 🧪 Tests fail inside the container

`./wakemeup.sh -a test-webapp` runs the suite inside the container. Common cause of failure:

- **Image too old** — the tests must be baked in at build time (npm is purged from the image afterwards). Rebuild first: `./wakemeup.sh -a build`, then `redeploy`.

Full test documentation: [Developpement → Testing](../UpOnLAN/Developpement.md#%F0%9F%A7%AA-testing).

---

## 📦 Data and recovery

The shipped manifests use ephemeral `emptyDir` storage for `/config`, `/assets`, `/menu`, and `/logs`. Pod replacement or `./wakemeup.sh -a destroy` does not preserve this data. See [Operations](Operations.md) for backup and recovery steps.

---

## ❓ Still stuck

- [Contribute](../UpOnLAN/Contribute.md) — how to report issues
- [iPXE.md](../iPXE.md) — boot environment basics
