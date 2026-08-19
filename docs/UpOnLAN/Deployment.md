## Deployment reference

### Requirements

- A Podman engine and permission to run the `sudo podman` commands used by `wakemeup.sh`.
- Host ports `8080/TCP`, `3000/TCP`, and `69/UDP` available. Port 69 is privileged and must not be occupied by another TFTP service.
- For `deploy --local`, Python 3 plus prepared `release/output` artifacts.

### Deploy modes

```bash
./wakemeup.sh -a deploy
```

The default deployment builds `localhost/uponlan:latest` and starts `manifests/uponlan.yaml`. It obtains menus and assets from the configured remote endpoint.

```bash
./wakemeup.sh -a mirror-assets
./scripts/release_menu.sh 0.0.2
./wakemeup.sh -a deploy --local
```

Local deployment serves `release/output` with `python3 -m http.server` on port `8899` and starts `manifests/uponlan-local.yaml`. It requires `release/output/assets/endpoints.yml` and `release/output/menu/0.0.2/menus.tar.gz`; it does not build either artifact.

### Security and network exposure

The shipped Nginx configuration listens on plain HTTP port `8080`; it does not provide HTTPS. The webapp is also published on `3000/TCP`, and TFTP is published on `69/UDP`.

- Restrict `69/UDP` to the PXE client network. Allow `8080/TCP` only where boot clients need HTTP assets and menus.
- Restrict `3000/TCP` to administrators, or place it behind a reverse proxy. Terminate TLS at that proxy when HTTPS is required; do not expose the shipped HTTP listener directly to untrusted networks.
- Basic authentication is disabled unless **both** `WEBAPP_USER` and `WEBAPP_PASS` are set. For a protected deployment, add both environment variables to the container in the manifest before deploying. Treat the manifest and its secret values as sensitive.

### Release artifacts

`./wakemeup.sh -a mirror-assets` runs `scripts/release_assets.sh` and recreates the asset side of `release/output`, under `release/output/assets/` (the `assets/endpoints.yml` catalog plus `assets/<asset-key>/` bundles). Set `asset_target=<os>` to build a single asset set, e.g. `asset_target=harvester ./wakemeup.sh -a mirror-assets`. A bare (untargeted) run wipes `release/output/assets/` and rebuilds every asset set in `release/assets/*/setting.sh`; a targeted run builds/refreshes only that one set on top of the existing mirror, so you can add asset sets incrementally (e.g. `asset_target=talos` after a full run adds only talos).

`./scripts/release_menu.sh <version>` updates `release/menus/version.ipxe` and writes the menu layer under `release/output/menu/` (`menu/latest` + `menu/<version>/menus.tar.gz`). It **fails fast** if the iPXE ROM artifacts (`release/menus/rom/ipxe/uponlan.xyz-undionly.kpxe`, `uponlan.xyz.kpxe`, `uponlan.xyz.efi`, `uponlan.xyz-e1000.rom`) are missing — the tarball must contain them so `init.sh` can populate the container's TFTP root. The two layers live in sibling directories, so an asset mirror run never clobbers the menu release.

The one-command release build is `scripts/build_release.sh <version>`: it runs the ROM build (`scripts/build_ipxe_roms.sh`), the asset mirror, and then `release_menu.sh` in that order, so the menu artifact can never be built against stale/missing ROMs.

### Release workflows

Two workflows produce the artifacts a deployment consumes.

**Local (testing) workflow** — build everything into `release/output/` on the host:

```bash
./wakemeup.sh -a mirror-assets            # asset layer: release/output/assets/{endpoints.yml,<key>/...}
./scripts/build_release.sh 0.0.2          # ROMs + menu layer: release/output/menu/{latest,0.0.2/menus.tar.gz}
./wakemeup.sh -a deploy --local           # serve release/output on :8899 and deploy the local manifest
```

The local deployment then points `ENDPOINT_URL` at `http://host.containers.internal:8899`, so `init.sh` and the webapp consume the local mirror exactly like a remote endpoint — the menu tarball from `menu/<version>/menus.tar.gz` and the asset catalog from `assets/endpoints.yml`. On a fresh host, `ansible-playbook ansible/release_ipxe.yml` installs the build toolchain (`build-essential`, `binutils`, `liblzma-dev`, `xz-utils`, `ipxe-qemu`, `ovmf`, `qemu-system-x86`) and runs the ROM build, including installing the host BIOS option ROM to `/usr/lib/ipxe/qemu/uponlan-e1000.rom`.

**Repository (GitHub) workflow** — `.github/workflows/release.yml` (manual `workflow_dispatch`):

1. Reads the webapp version from `src/webapp/package.json`; that version becomes the release tag.
2. Fails if a git tag with that version already exists.
3. Runs `scripts/release_assets.sh` and `scripts/release_menu.sh <version>` in CI.
4. Uploads `release/output/**/*` as flat assets to the GitHub release under that tag.

A deployment pointed at `ENDPOINT_URL=https://github.com/mozebaltyk/uponlan` fetches the menu tarball from `${ENDPOINT_URL}/releases/download/${MENU_VERSION}/menus.tar.gz` and the asset catalog from `${ENDPOINT_URL}/endpoints.yml` (the GitHub branch uses the `releases/download/` path while the local mirror uses `menu/` + `assets/` — `init.sh` switches on whether the endpoint is a GitHub URL).

> ⚠️ Known gaps in the repository workflow:
> - The dedicated `release_assets` CI job is **commented out**. Assets are built inside the menu job, so every menu release re-downloads all asset bundles (multi-GB) on CI, and there is no way to release assets on their own.
> - Only the menu tag is published. Asset URLs resolve on GitHub only if a release exists under the exact asset tag (`<os>-<version>-<arch>`); the workflow uploads everything to the single menu version tag, so per-OS bundle URLs (and the Assets-tab download links for a GitHub origin) point at releases that must be created separately. Local mirroring (`deploy --local`) is unaffected because it serves the `assets/` namespace directly.

### CLI actions

`./wakemeup.sh -a <action> [--local]` supports: `build`, `deploy`, `destroy`, `redeploy`, `logs`, `connect`, `mirror-assets`, `build-runner`, `run-runner`, and `test-webapp`. `--local` applies to `deploy` and `redeploy`. The runner actions are optional and are not required for webapp menu/ROM builds.

### Test-VM provisioning (diskless PXE guest)

The web console's VM tab creates a diskless KVM guest (no disk, no VGA, PTY serial on port 0) on the `uponlan` libvirt network with a BIOS/UEFI firmware selector. The guest must load an iPXE **binary** before any menu can render: the VM firmware (SeaBIOS/OVMF) does not interpret iPXE scripts, and Ubuntu's QEMU ships no e1000 PXE option ROM, so without the ROM (BIOS) or the OVMF network stack fetch (UEFI) the guest never even DHCPs. See [ROM Build](../iPXE/ROM%20Build.md) for why the serial console additionally requires a `CONSOLE_SERIAL` ROM build.

- **BIOS**: attaches the iPXE e1000 option ROM (`/usr/lib/ipxe/qemu/uponlan-e1000.rom`) — SeaBIOS loads it, iPXE DHCPs, and chains the serial menu.
- **UEFI**: `<os firmware='efi'>` — libvirt picks OVMF and manages a per-guest NVRAM. OVMF PXE-boots, TFTPs `rom/ipxe/uponlan.xyz.efi` (delivered via `dhcp-boot`/option 67 matched on client arch option 93 = 7), and iPXE renders the same serial menu.
- Destroying a UEFI guest removes its NVRAM (`virsh undefine --nvram`); without this, re-creating the VM is blocked by a stale NVRAM file.

The network's dnsmasq intentionally has **no `pxe-service`/`pxe-prompt` lines**: dnsmasq's PXE processing (enabled only by those) injects option 60 `PXEClient` + option 43 into every offer, which makes EDK2/OVMF abort with `PXE-E21: Remote boot cancelled` before any TFTP. Boot files are advertised solely via `dhcp-boot` tags (`ipxe-bios`/`ipxe-efi` on option 175, `uefi-fw` on option 93).
