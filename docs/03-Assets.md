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

There are two `BUILD_TYPE`s in `release/assets/`, and they now take **different release paths**:

| `BUILD_TYPE` | Behavior | Release path |
| --- | --- | --- |
| `direct_file` | list vendor URLs per file (no extraction); imported on-demand by the Assets tab | catalog-only — entries ship in `endpoints.yml`, but no bundle is mirrored to GitHub |
| `iso_extraction` | download an ISO, then extract kernel/initrd/rootfs out of it | build-time pipeline + GitHub |

`direct_file` recipes list the vendor URLs directly (`talos`, `ubuntu`, `harvester`, `proxmox`): the catalog entry records those URLs in `sources` (aligned with `files`) plus `build_type: direct_file`, and the **Assets tab** pulls each file from its vendor URL into `/assets/<key>/` on demand. The **catalog entries are still published** (so a remote deploy knows what can be imported), but no direct_file bundle is uploaded to GitHub. `iso_extraction` (no current consumer — Oracle was the only one, removed) still downloads the ISO at build time and extracts the kernel/initrd for GitHub publication, because those files aren't always published separately by the vendor.

`direct_file` fetches whatever the recipe lists — usually small prebuilt boot files (`talos`, `ubuntu`, `harvester`), but `proxmox` also lists a full installer ISO (`proxmox.iso`), imported as a plain file and booted directly. Proxmox publishes no stable directly-downloadable netboot initrd, so that ISO plus the boot files are listed from `netbootxyz/asset-mirror`.

> ⚠️ **GitHub release-asset cap — 2 GB.** Release assets are limited to 2 GB. An `iso_extraction` recipe must delete the downloaded DVD after extracting it (`release/assets/build.sh` does this) — that is what made Oracle's ~10 GB image fail. The `proxmox.iso` fetched by `direct_file` works only while it stays under 2 GB, so watch it as Proxmox releases grow.

netboot.xyz hosts its extracted files in `netbootxyz/asset-mirror` and documents the whole pipeline in `netbootxyz/build-pipelines` (a thorough write-up of the why and how: the 2 GB release-asset limit, the 302→S3 redirect, and the per-distro initrd patches for casper/live-boot/miso/dracut). UpOnLAN applies the same pattern locally through `release/assets/<os>/setting.sh` and `scripts/release_assets.sh`.

---

## 🔗 How menus link to assets

A menu entry boots an OS by fetching its kernel, initramfs, and rootfs over HTTP. Nothing "links" the two — the iPXE script and the endpoint catalog must simply agree on the URL layout:

```text
iPXE menu (.ipxe)                      endpoint catalog (endpoints.yml)
    │                                          │
    │ kernel ${local_endpoint}<key>/vmlinuz    │  path: /assets/<key>/        (direct_file, local)
    │ initrd  ${local_endpoint}<key>/initrd    │  build_type: direct_file
    │                                          │  sources: [<vendor URL>, ...]
    │                                          │
    │ kernel ${mirror_endpoint}${asset_path}<key>/vmlinuz
    │                                          │  path: /releases/download/<key>/  (iso_extraction, GitHub)
    ▼                                          ▼
<key> = <os>-<version>-<arch>; the files must match the endpoint's `files`
```

1. **`endpoints.yml`** declares a boot bundle: a `path` plus the `files` served under it (kernel, initrd, rootfs, checksums...). Its `path` is relative to the *asset origin*: `/assets/<key>/` for the local mirror, `/releases/download/<key>/` for GitHub release assets. `direct_file` entries also carry `build_type: direct_file` and `sources` (the vendor URLs, aligned with `files`); `iso_extraction` entries carry `build_type: iso_extraction` with no per-file vendor source.
2. **The Assets tab** resolves each *Pull Selected* (`dlremote`) path: a `direct_file` entry downloads from its vendor `sources[index]` URL, an `iso_extraction` entry downloads from the configured origin (`origin + path`). Files land under `/assets/<key>/`, and nginx serves `/assets` as its web root, so every imported file is reachable at `<boot host>:${NGINX_PORT}/<key>/<file>`.
3. **The iPXE menu** points `kernel` / `initrd` / rootfs at exactly those URLs, via the variables defined in `release/menus/boot.cfg`:
   - `${local_endpoint}` — the local nginx origin for **`direct_file`** assets, default `http://192.168.7.1:8080/` (trailing slash included), overridable in `release/menus/local-vars.ipxe`.
   - `${mirror_endpoint}` / `${asset_path}` — the GitHub origin for **`iso_extraction`** assets. Defaults to `https://github.com/MozeBaltyk/UpOnLAN` + `/releases/download/`.

The full boot URL is `${local_endpoint}<key>/<file>` for `direct_file` (nginx maps `<key>/<file>` to `/assets/<key>/<file>`), and `${mirror_endpoint}${asset_path}<key>/<file>` for `iso_extraction`.

The consequence: **the `<key>` and file names in a menu must match an endpoint's `<key>` + `files`** in `endpoints.yml`. If they drift, the boot fails even though the assets are fully imported.

> ⚠️ Current state of the shipped menus: `talos.ipxe`, `harvester.ipxe`, `rockylinux.ipxe`, `proxmox.ipxe` (PBS/PMG/VE), and `ubuntu.ipxe` (subiquity) are all `direct_file` and chain `${local_endpoint}<key>/`. No shipped menu currently exercises `iso_extraction` (no recipe of that type exists), so `${mirror_endpoint}${asset_path}` is defined in `boot.cfg` but unused until one is added. The only remaining vendor-direct entry is `ubuntu.ipxe`'s legacy `d-i` installer, which boots `${ubuntu_mirror}` (archive.ubuntu.com). `boot.cfg`'s `${live_endpoint}` is now unused.

---

## ☁️ Cloud-init seeds as assets

[cloud-init](https://cloudinit.readthedocs.io/) does post-boot provisioning — hostname, users/SSH keys, network, packages, run-commands — and it's independent of *how* the machine booted, so it composes cleanly with PXE: PXE delivers the kernel + initrd, cloud-init configures the OS that comes up.

The bridge is cloud-init's **NoCloud** datasource, which fetches its seed over HTTP from a URL passed on the **kernel command line**:

```ipxe
ds=nocloud;s=http://<server>/<path>/
```

cloud-init then GETs `<path>/user-data` and `<path>/meta-data`. A seed is therefore just two files the guest pulls over HTTP *at boot time* — exactly like a kernel or initrd — which is why it belongs in the asset model rather than as a separate mechanism:

- **Same transport** — served from the same `${local_endpoint}` origin the menu already uses.
- **Versioned** — a specific `user-data` per deployment, not "whatever is on the host today".
- **Mirrorable** — `--local` / *Pull Selected* imports it into `/assets/` for offline booting; `ds=nocloud;s=…` must resolve from the guest's network on first boot.

The menu references it like any other bundle:

```ipxe
kernel ${url}vmlinuz ds=nocloud;s=${local_endpoint}<key>/ …
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
    build_type: direct_file            # direct_file | iso_extraction
    sources:                           # vendor URLs, aligned with `files`
    - https://github.com/siderolabs/talos/releases/download/v1.13.8/vmlinuz-amd64
    - https://github.com/siderolabs/talos/releases/download/v1.13.8/initramfs-amd64.xz
```

> `path` is `/assets/<key>/` for the local mirror and `/releases/download/<key>/` for GitHub release assets (`release/assets/build.sh` sets it from `MIRROR_LAYOUT`). `sources` is only meaningful for `direct_file` (the Assets tab imports from it); `iso_extraction` entries omit per-file sources because their files are extracted from one ISO at build time. The menu never hardcodes the origin — `direct_file` menus chain `${local_endpoint}<key>/`, `iso_extraction` menus `${mirror_endpoint}${asset_path}<key>/`.

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
   set <os>_url ${local_endpoint}<key>/
   kernel ${<os>_url}vmlinuz <boot params>
   initrd ${<os>_url}initrd
   boot
   ```

   Use `<key> = <os>-<version>-<arch>` exactly as generated, and the exact file names from `endpoints.yml` `files`. This is the contract — no other "wiring" exists between menu and assets. (For an `iso_extraction` recipe, chain `${mirror_endpoint}${asset_path}<key>/` instead.)

3. **Register the entry** in the parent menu so it appears in the menu tree. For a Linux installer, add an `item <os> <label>` to `release/menus/linux.ipxe` (and `linux-arm.ipxe` if it has an arm64 bundle). The main `menu.ipxe` chains `linux.ipxe` when the user selects *Linux Network Installs*.

4. **Rebuild and redeploy.** Run `scripts/release_menu.sh <version>` (warns if the ROMs are missing — build them first so they're included) then `./wakemeup.sh -a redeploy --local`, or the one-shot `scripts/build_release.sh <version>`. The new entry appears on the next boot.

A working reference is `talos.ipxe` + `release/assets/talos/setting.sh`: the recipe lists `vmlinuz`/`initrd` vendor URLs for `<key> = talos-v1.13.8-<arch>`, and the menu boots `${local_endpoint}talos-v1.13.8-${arch}/vmlinuz` with a config-URL parameter item.
