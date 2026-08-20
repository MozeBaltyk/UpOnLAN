## Assets in UpOnLAN

iPXE gives you a menu, but the menu itself only defines where to boot from. At some point, you need to redirect the client to an actual bootable payload. This could be a public mirror on the Internet, or (in many cases) you'll want to host and serve these assets locally.

---

## 🔧 What You Need to Live Boot

In simple terms, a typical Live CD (or PXE boot image) requires 3 main components to boot an operating system over the network:

- [x] **Kernel** — The Linux kernel itself, responsible for interacting with the hardware.
- [x] **Initramfs** — A minimal filesystem loaded into RAM that initializes the system before handing off control.
- [x] **SquashFS** — The compressed root filesystem containing the actual operating system the user will run.

The general flow is:
1. The kernel loads.
2. The initramfs is executed, initializing devices and network.
3. The initramfs locates and downloads the SquashFS, loads it into RAM, and finally hands off control to the main OS (often using modern init managers like `systemd` or `upstart`).

---

## 🚧 Why UpOnLAN Helps

One of the key problems UpOnLAN solves is **making these three components available locally**, even when:

- The original vendor doesn’t provide stable HTTPS downloads.
- The initramfs cannot verify HTTPS endpoints (due to missing CA certificates).
- The target machine cannot access the public Internet at all (offline provisioning).
  
This is why the **Assets** tab exists in the web app:

- ✅ Mirror LiveCDs locally.
- ✅ Serve these assets over the configured Nginx HTTP port. Put a TLS-capable reverse proxy in front if HTTPS is required.
- ✅ Provide helper scripts to extract kernel, initramfs, and squashfs directly from ISO files.
- ✅ Automatically populate an `endpoints.yml` configuration file for your iPXE menus.

This allows you to fully control and serve all necessary assets locally, ensuring reliable and repeatable booting even in isolated environments.

---

## 🌍 Why re-host assets instead of pointing at the vendor

UpOnLAN mirrors boot files for the same reason [netboot.xyz](https://netboot.xyz) does — captured in one line by netboot.xyz's `asset-mirror` repo: *"mirror for assets we are unable to reliably consume with iPXE."*

- **Vendors publish ISOs, not iPXE-ready components.** iPXE needs a small kernel + initramfs (+ optional rootfs) it can fetch over HTTP. Most vendors — Oracle and the whole RHEL-family included — only publish a full DVD ISO; the kernel/initrd inside are never extracted and offered as standalone downloads.
- **iPXE doesn't boot ISOs directly.** A multi-gigabyte ISO can't be pulled into memory by a bootloader; you have to extract the small pieces and chain them.
- **The initramfs usually can't speak HTTPS.** The pre-boot environment ships without CA certificates (or a working `wget`/`curl`) in most distros, and GitHub Releases are HTTPS endpoints that 302-redirect to S3. So an initrd often needs patching before it can pull a rootfs over the network.

There are two `BUILD_TYPE`s in `release/assets/`:

| `BUILD_TYPE` | Behavior | Used by |
| --- | --- | --- |
| `direct_file` | download each `EXTRACTS` file verbatim (no extraction) | `talos`, `ubuntu`, `harvester`, `proxmox` |
| `iso_extraction` | download an ISO, then extract kernel/initrd/rootfs out of it | unused (Oracle was the only consumer, removed) |

`direct_file` fetches whatever the recipe lists — usually small prebuilt boot files (`talos`, `ubuntu`, `harvester`), but `proxmox` also lists a full installer ISO (`proxmox.iso`), downloaded as a plain file and booted directly. Proxmox publishes no stable directly-downloadable netboot initrd, so that ISO plus the boot files are mirrored from `netbootxyz/asset-mirror`.

> ⚠️ **GitHub release-asset cap — 2 GB.** Release assets are limited to 2 GB. An `iso_extraction` recipe must delete the downloaded DVD after extracting it (`release/assets/build.sh` does this) — that is what made Oracle's ~10 GB image fail. The `proxmox.iso` fetched by `direct_file` works only while it stays under 2 GB, so watch it as Proxmox releases grow.

netboot.xyz hosts its extracted files in `netbootxyz/asset-mirror` and documents the whole pipeline in `netbootxyz/build-pipelines` (a thorough write-up of the why and how: the 2 GB release-asset limit, the 302→S3 redirect, and the per-distro initrd patches for casper/live-boot/miso/dracut). UpOnLAN applies the same pattern locally through `release/assets/<os>/setting.sh` and `scripts/release_assets.sh`.

---

## 🔗 How menus link to assets

A menu entry boots an OS by fetching its kernel, initramfs, and rootfs over HTTP. Nothing "links" the two — the iPXE script and the endpoint catalog must simply agree on the URL layout:

```text
iPXE menu (.ipxe)                      endpoint catalog (endpoints.yml)
    │                                          │
    │ kernel ${mirror_endpoint}${asset_path}<key>/vmlinuz
    │ initrd  ${mirror_endpoint}${asset_path}<key>/initrd
    │                                          │  path: /assets/<key>/  (local mirror)
    │                                          │  files: [vmlinuz, initrd, squashfs.img]
    ▼                                          ▼
<key> = <os>-<version>-<arch>; the files must match the endpoint's `files`
```

1. **`endpoints.yml`** declares a boot bundle: a `path` plus the `files` served under it (kernel, initrd, rootfs, checksums...). Its `path` is relative to the *asset origin*: `/assets/<key>/` for the local mirror, `/releases/download/<key>/` for GitHub release assets.
2. **The Assets tab** mirrors those files with *Pull Selected* (`dlremote`): each `path + file` is downloaded from the configured origin into `/assets/<key>/`. Nginx serves `/assets` as its web root, so every mirrored file is reachable at `<boot host>:${NGINX_PORT}/<key>/<file>`.
3. **The iPXE menu** points `kernel` / `initrd` / rootfs at exactly those URLs, via two variables defined in `release/menus/boot.cfg`:
   - `${mirror_endpoint}` — the boot origin for **your** mirrored assets. Defaults to `https://github.com/MozeBaltyk/UpOnLAN`; a local deployment overrides it in `release/menus/local-vars.ipxe` to the nginx URL (e.g. `http://192.168.7.1:8080`).
   - `${asset_path}` — the path prefix. Defaults to `/releases/download/` (GitHub release layout); the local override sets it to `/` because nginx serves `/assets` at its root, so the local URL is `<mirror_endpoint>/<key>/<file>`.

The full boot URL is `${mirror_endpoint}${asset_path}<key>/<file>`. On GitHub that resolves to `https://github.com/MozeBaltyk/UpOnLAN/releases/download/<key>/<file>`; locally it resolves to `http://192.168.7.1:8080/<key>/<file>` (which nginx maps to `/assets/<key>/<file>`).

The consequence: **the `<key>` and file names in a menu must match an endpoint's `<key>` + `files`** in `endpoints.yml`. If they drift, the boot fails even though the assets are fully mirrored.

> ⚠️ Current state of the shipped menus: `talos.ipxe`, `harvester.ipxe`, `rockylinux.ipxe`, `proxmox.ipxe` (PBS/PMG/VE), and `ubuntu.ipxe` (subiquity) all use the endpoint layout above (`${mirror_endpoint}${asset_path}<key>/`) and have mirrored recipes under `release/assets/`. The only remaining vendor-direct entry is `ubuntu.ipxe`'s legacy `d-i` installer, which boots `${ubuntu_mirror}` (archive.ubuntu.com). `boot.cfg`'s `${live_endpoint}` is now unused.

---

## ☁️ Cloud-init seeds as assets

[cloud-init](https://cloudinit.readthedocs.io/) does post-boot provisioning — hostname, users/SSH keys, network, packages, run-commands — and it's independent of *how* the machine booted, so it composes cleanly with PXE: PXE delivers the kernel + initrd, cloud-init configures the OS that comes up.

The bridge is cloud-init's **NoCloud** datasource, which fetches its seed over HTTP from a URL passed on the **kernel command line**:

```ipxe
ds=nocloud;s=http://<server>/<path>/
```

cloud-init then GETs `<path>/user-data` and `<path>/meta-data`. A seed is therefore just two files the guest pulls over HTTP *at boot time* — exactly like a kernel or initrd — which is why it belongs in the asset model rather than as a separate mechanism:

- **Same transport** — served from the same `${mirror_endpoint}` origin the menu already uses.
- **Versioned** — a specific `user-data` per deployment, not "whatever is on the host today".
- **Mirrorable** — `--local` / *Pull Selected* copies it into `/assets/` for offline booting; `ds=nocloud;s=…` must resolve from the guest's network on first boot.

The menu references it like any other bundle:

```ipxe
kernel ${url}vmlinuz ds=nocloud;s=${mirror_endpoint}${asset_path}<key>/ …
initrd ${url}initrd
```

So a cloud-init seed is a `direct_file` asset whose `files` are `user-data` + `meta-data` instead of `vmlinuz`/`initrd`; its only real difference is that the guest consumes it mid-boot rather than as a menu entry — the "category" to surface in the Assets tab.

> ⚠️ Planned, not implemented — tracked in the TODO under *Cloud-init assets*.

---

## ➕ Adding a New Endpoint

An **endpoint** is one entry in `endpoints.yml` that points an iPXE menu (and the Assets tab in the webapp) at a bootable bundle. The key is unique and doubles as the release tag/directory the files are served from:

```yaml
endpoints:
  talos-v1.13.8-x86_64:                # unique key == release tag == directory
    path: /assets/talos-v1.13.8-x86_64/ # files are served under <origin><path>
    files:
    - vmlinuz                          # kernel
    - initrd                           # initramfs
    os: talos                          # shown in the Assets tab
    version: v1.13.8
    arch: x86_64
```

> `path` is `/assets/<key>/` for the local mirror and `/releases/download/<key>/` for GitHub release assets (`release/assets/build.sh` sets it from `MIRROR_LAYOUT`). The menu never hardcodes either — it composes `${mirror_endpoint}${asset_path}<key>/`.

To add a new endpoint:

1. **Create a build recipe** at `release/assets/<os>/setting.sh`. The script is sourced by `release/assets/build.sh` and must export `OS`, `VERSION`, `ARCHS`, `BUILD_TYPE`, and `EXTRACTS` (`URL|output_file` lines, one per file, with `REPLACE_ARCH` for per-arch URLs). See `release/assets/talos/setting.sh` for a `direct_file` recipe (download prebuilt artifacts).
2. **Run `scripts/release_assets.sh [<os>]`** — it executes the recipe and writes the generated entry to `release/output/assets/endpoints.yml` (the catalog `init.sh` fetches and serves to the webapp).

The generated endpoint key is `${OS}-${VERSION}-${GENERIC_ARCH}` (`amd64` → `x86_64`, `aarch64` → `arm64`), so one multi-arch OS produces one endpoint per architecture.

## ➕ Develop a new menu with its own assets

Adding a brand-new boot entry is a two-sided change: an **asset recipe** (so the kernel/initrd/rootfs exist) and a **menu entry** (so the iPXE menu offers it and points at those files). End to end:

1. **Write the asset recipe** `release/assets/<os>/setting.sh` (see *Adding a New Endpoint* above) and run `./wakemeup.sh -a mirror-assets` (or `asset_target=<os> ... -a mirror-assets`) to produce `release/output/assets/<key>/` and its `endpoints.yml` entry.

2. **Write the menu script** `release/menus/<os>.ipxe`. The boot handler composes its URLs from the two `boot.cfg` variables and the endpoint key:

   ```ipxe
   #!ipxe
   goto ${menu} ||

   :<os>
   set <os>_url ${mirror_endpoint}${asset_path}<key>/
   kernel ${<os>_url}vmlinuz <boot params>
   initrd ${<os>_url}initrd
   boot
   ```

   Use `<key> = <os>-<version>-<arch>` exactly as generated, and the exact file names from `endpoints.yml` `files`. This is the contract — no other "wiring" exists between menu and assets.

3. **Register the entry** in the parent menu so it appears in the menu tree. For a Linux installer, add an `item <os> <label>` to `release/menus/linux.ipxe` (and `linux-arm.ipxe` if it has an arm64 bundle). The main `menu.ipxe` chains `linux.ipxe` when the user selects *Linux Network Installs*.

4. **Rebuild and redeploy.** Run `scripts/release_menu.sh <version>` (warns if the ROMs are missing — build them first so they're included) then `./wakemeup.sh -a redeploy --local`, or the one-shot `scripts/build_release.sh <version>`. The new entry appears on the next boot.

A working reference is `talos.ipxe` + `release/assets/talos/setting.sh`: the recipe mirrors `vmlinuz`/`initrd` to `<key> = talos-v1.13.8-<arch>`, and the menu boots `${mirror_endpoint}${asset_path}talos-v1.13.8-${arch}/vmlinuz` with a config-URL parameter item.
