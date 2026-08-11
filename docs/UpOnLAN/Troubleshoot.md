## 🔧 Troubleshooting UpOnLAN

Quick checks and fixes for the most common problems. All container operations go through `./wakemeup.sh`.

---

## 🚧 Webapp unreachable

1. Is the container running? `./wakemeup.sh -a network` shows pod and container status.
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

---

## 🧱 Menu build fails in the webapp

Builds run in a separate Ansible container:

1. `./wakemeup.sh -a run-runner` starts the runner container.
2. `./wakemeup.sh -a connect` gets a shell; build logs are stored in `/logs/ansible/`.
3. If the runner image is outdated: `./wakemeup.sh -a build-runner` first.

---

## 🧪 Tests fail inside the container

`./wakemeup.sh -a test-webapp` runs the suite inside the container. Common cause of failure:

- **Image too old** — the tests must be baked in at build time (npm is purged from the image afterwards). Rebuild first: `./wakemeup.sh -a build`, then `redeploy`.

Full test documentation: [Developpement → Testing](../UpOnLAN/Developpement.md#%F0%9F%A7%AA-testing).

---

## 📦 Persistent data

Data survives redeploys in named volumes (see `wakemeup.sh`):

| Volume | Mount | Content |
|--------|-------|---------|
| `uponlan-config` | `/config` | `endpoints.yml`, menu files |
| `uponlan-assets` | `/assets` | Mirrored bootable assets |
| — | `/docs` | Served documentation |
| — | `/logs` | Webapp / nginx / ansible logs |

`./wakemeup.sh -a destroy` removes the container **and** its images — volumes are kept, so configuration and assets survive.

---

## ❓ Still stuck

- [Contribute](../UpOnLAN/Contribute.md) — how to report issues
- [iPXE.md](../iPXE.md) — boot environment basics
