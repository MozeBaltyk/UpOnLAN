## Deployment reference

### Requirements

- A Podman engine and permission to run the `sudo podman` commands used by `wakemeup.sh`.
- Host ports `8080/TCP`, `3000/TCP`, and `69/UDP` available. Port 69 is privileged and must not be occupied by another TFTP service.
- For `deploy --local`, Python 3 plus prepared `release/output` artifacts.

### Deploy modes

`wakemeup.sh` renders the Helm chart (`charts/uponlan/`) and pipes it to `podman play kube -`. Three modes:

```bash
./wakemeup.sh -a deploy               # pull ghcr.io/.../uponlan:latest + remote (GitHub), no build
./wakemeup.sh -a deploy --build       # build localhost/uponlan:latest + remote (GitHub)
./wakemeup.sh -a deploy --local       # build locally + serve release/output on :8899
```

- **default** — pulls `ghcr.io/mozebaltyk/uponlan:latest`; `MENU_VERSION` is left empty so `init.sh` resolves `releases/latest` on GitHub.
- **`--build`** — builds `localhost/uponlan:latest` and deploys it against GitHub assets (local development).
- **`--local`** — builds locally and serves `release/output` on `:8899`; requires `release/output/assets/endpoints.yml` and `release/output/menu/0.1.0/menus.tar.gz` (build them with `./wakemeup.sh -a mirror-assets` + `./scripts/release_menu.sh 0.1.0`); pins `MENU_VERSION` from `release/menus/version.ipxe`.

`./wakemeup.sh -a preview` prints the resolved context (image / endpoint / menu version / ports) and runs preflight checks — host ports free, `podman` + `helm` present, ghcr login, and the libvirt socket — without deploying anything. `deploy` runs the same checks and aborts on a hard failure (missing `podman`/`helm`); a port already in use only warns, since `deploy` is idempotent (`--replace` recreates the running pod).

### Security and network exposure

The shipped Nginx configuration listens on plain HTTP port `8080`; it does not provide HTTPS. The webapp is also published on `3000/TCP`, and TFTP is published on `69/UDP`.

- Restrict `69/UDP` to the PXE client network. Allow `8080/TCP` only where boot clients need HTTP assets and menus.
- Restrict `3000/TCP` to administrators, or place it behind a reverse proxy. Terminate TLS at that proxy when HTTPS is required; do not expose the shipped HTTP listener directly to untrusted networks.
- Basic authentication is disabled unless **both** `WEBAPP_USER` and `WEBAPP_PASS` are set. For a protected deployment, add both environment variables to the container in the manifest before deploying. Treat the manifest and its secret values as sensitive.

### Release artifacts

`./wakemeup.sh -a mirror-assets` runs `scripts/release_assets.sh` and recreates the asset side of `release/output`, under `release/output/assets/` (the `assets/endpoints.yml` catalog plus `assets/<asset-key>/` bundles). Set `asset_target=<os>` to build a single asset set, e.g. `asset_target=harvester ./wakemeup.sh -a mirror-assets`. A bare (untargeted) run wipes `release/output/assets/` and rebuilds every asset set in `release/assets/*/setting.sh`; a targeted run builds/refreshes only that one set on top of the existing mirror, so you can add asset sets incrementally (e.g. `asset_target=talos` after a full run adds only talos).

`./scripts/release_menu.sh <version>` updates `release/menus/version.ipxe` and writes the menu layer under `release/output/menu/` (`menu/latest` + `menu/<version>/menus.tar.gz`). It **warns** — and no longer aborts — if the iPXE ROM artifacts (`release/menus/rom/ipxe/uponlan.xyz-undionly.kpxe`, `uponlan.xyz.kpxe`, `uponlan.xyz.efi`, `uponlan.xyz-e1000.rom`) are missing; build them first so the tarball carries them and `init.sh` can populate the container's TFTP root. The two layers live in sibling directories, so an asset mirror run never clobbers the menu release.

The one-command release build is `scripts/build_release.sh <version>`: it runs the ROM build (`scripts/build_ipxe_roms.sh`), the asset mirror, and then `release_menu.sh` in that order, so the menu artifact can never be built against stale/missing ROMs.

### Release workflows

The release is split across **three independent, manually-triggered workflows** so the container image, the menu, and the asset bundles can each ship on their own schedule (a menu fix does not force a multi-GB rebuild of every asset):

| Workflow     | Produces          | Destination                                                                 |
| ------------ | ----------------- | --------------------------------------------------------------------------- |
| `image.yml`  | the webapp container | `ghcr.io/mozebaltyk/uponlan:<version>` + `latest`                          |
| `release.yml` | the menu tarball | GitHub Release tag `<version>`, asset `menus.tar.gz`                        |
| `assets.yml` | asset bundles     | one GitHub release per bundle (tag = `<key>`) + an `assets` tag carrying `endpoints.yml` |

**Local (testing) workflow** — build everything into `release/output/` on the host:

```bash
./wakemeup.sh -a mirror-assets            # asset layer: release/output/assets/{endpoints.yml,<key>/...}
./scripts/build_release.sh 0.1.0          # ROMs + menu layer: release/output/menu/{latest,0.1.0/menus.tar.gz}
./wakemeup.sh -a deploy --local           # serve release/output on :8899 and deploy the local manifest
```

The local deployment then points `ENDPOINT_URL` at `http://host.containers.internal:8899`, so `init.sh` and the webapp consume the local mirror exactly like a remote endpoint — the menu tarball from `menu/<version>/menus.tar.gz` and the asset catalog from `assets/endpoints.yml`. On a fresh host, install the build toolchain and run the ROM build directly (no Ansible):

```bash
sudo apt-get install -y build-essential binutils liblzma-dev xz-utils ipxe-qemu ovmf qemu-system-x86
./scripts/build_release.sh <version>   # runs build_ipxe_roms.sh (installs the host option ROM) + assets + menu
```

**Repository (GitHub) workflow** — three `workflow_dispatch` jobs in `.github/workflows/`:

- `release.yml` (menu): builds the iPXE ROMs (`build_ipxe_roms.sh`), packs `release_menu.sh <version>`, and uploads `menus.tar.gz` as the `<version>` release asset.
- `assets.yml`: installs `yq` + `p7zip-full`, runs `MIRROR_LAYOUT=github scripts/release_assets.sh`, then creates one release per bundle whose **tag is the endpoint key** (`proxmox-ve-8.4-1-x86_64` → `releases/download/<key>/vmlinuz`). It also publishes `endpoints.yml` on a stable `assets` tag.
- `image.yml`: builds the Containerfile and pushes the image to GHCR.

Two conventions keep the decoupled releases from colliding:

1. **Asset releases are `--prerelease`.** GitHub's `releases/latest` (used by `init.sh` to resolve `MENU_VERSION` and by the dashboard's *remote menu version*) skips prereleases, so it stays pinned to the menu release even after asset bundles are published.
2. **Menu versions are bare semver.** `fetchDevReleases` filters the release list to `^v?\d+\.\d+\.\d+$`, so asset tags never surface as "menu versions" in the endpoint browser.

A deployment pointed at `ENDPOINT_URL=https://github.com/mozebaltyk/uponlan` fetches the menu tarball from `${ENDPOINT_URL}/releases/download/${MENU_VERSION}/menus.tar.gz` and the asset catalog from `${ENDPOINT_URL}/releases/download/assets/endpoints.yml` (`init.sh` switches on whether the endpoint is a GitHub URL — `releases/download/` for GitHub, `menu/` + `assets/` for a local mirror).

The full CI setup — test pipeline plus the three release workflows and their conventions — is documented in [CI pipelines](UpOnLAN.xyz/04-CI.md).

### CLI actions

`./wakemeup.sh -a <action> [--local]` supports: `build`, `deploy`, `destroy`, `redeploy`, `logs`, `connect`, `mirror-assets`, and `test-webapp`. `--local` applies to `deploy` and `redeploy`.

### Test-VM provisioning (diskless PXE guest)

The web console's VM tab creates a diskless KVM guest (no disk, no VGA, PTY serial on port 0) on the `uponlan` libvirt network with a BIOS/UEFI firmware selector. The guest must load an iPXE **binary** before any menu can render: the VM firmware (SeaBIOS/OVMF) does not interpret iPXE scripts, and Ubuntu's QEMU ships no e1000 PXE option ROM, so without the ROM (BIOS) or the OVMF network stack fetch (UEFI) the guest never even DHCPs. See [ROM Build](iPXE/03-ROM-Build.md) for why the serial console additionally requires a `CONSOLE_SERIAL` ROM build.

- **BIOS**: attaches the iPXE e1000 option ROM (`/usr/lib/ipxe/qemu/uponlan-e1000.rom`) — SeaBIOS loads it, iPXE DHCPs, and chains the serial menu.
- **UEFI**: `<os firmware='efi'>` — libvirt picks OVMF and manages a per-guest NVRAM. OVMF PXE-boots, TFTPs `rom/ipxe/uponlan.xyz.efi` (delivered via `dhcp-boot`/option 67 matched on client arch option 93 = 7), and iPXE renders the same serial menu.
- Destroying a UEFI guest removes its NVRAM (`virsh undefine --nvram`); without this, re-creating the VM is blocked by a stale NVRAM file.

The network's dnsmasq intentionally has **no `pxe-service`/`pxe-prompt` lines**: dnsmasq's PXE processing (enabled only by those) injects option 60 `PXEClient` + option 43 into every offer, which makes EDK2/OVMF abort with `PXE-E21: Remote boot cancelled` before any TFTP. Boot files are advertised solely via `dhcp-boot` tags (`ipxe-bios`/`ipxe-efi` on option 175, `uefi-fw` on option 93).
