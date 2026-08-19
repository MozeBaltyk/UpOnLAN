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

> ⚠️ Current state of the shipped menus: `talos.ipxe`, `harvester.ipxe`, and `oracle.ipxe` already use the endpoint layout above (`${mirror_endpoint}${asset_path}<key>/`). `proxmox.ipxe` and `ubuntu.ipxe` still use the upstream Netboot.xyz layout via the separate `${live_endpoint}` (`https://github.com/netbootxyz`), so they boot from the Netboot.xyz mirror until an UpOnLAN recipe for them is mirrored — see the *Develop a new menu with its own assets* section further down.

---

## ➕ Adding a New Endpoint

An **endpoint** is one entry in `endpoints.yml` that points an iPXE menu (and the Assets tab in the webapp) at a bootable bundle. The key is unique and doubles as the release tag/directory the files are served from:

```yaml
endpoints:
  oracle-9-x86_64:                     # unique key == release tag == directory
    path: /assets/oracle-9-x86_64/     # files are served under <origin><path>
    files:
    - vmlinuz                          # kernel
    - initrd                           # initramfs
    - squashfs.img                     # rootfs (if the OS uses one)
    os: oracle                         # shown in the Assets tab
    version: '9'
    arch: x86_64
```

> `path` is `/assets/<key>/` for the local mirror and `/releases/download/<key>/` for GitHub release assets (`release/assets/build.sh` sets it from `MIRROR_LAYOUT`). The menu never hardcodes either — it composes `${mirror_endpoint}${asset_path}<key>/`.

To add a new endpoint:

1. **Create a build recipe** at `release/assets/<os>/setting.sh`. The script is sourced by `release/assets/build.sh` and must export `OS`, `VERSION`, `ARCHS`, `BUILD_TYPE`, and `EXTRACTS` (`URL|output_file` lines, one per file, with `REPLACE_ARCH` for per-arch URLs). See `release/assets/talos/setting.sh` for `direct_file` (download prebuilt artifacts) and `release/assets/oracle9/setting.sh` for `iso_extraction` (pull kernel/initrd/rootfs out of an ISO).
2. **Run `scripts/release_assets.sh [<os>]`** — it executes the recipe and appends the generated entry to `release/output/assets/endpoints.yml` (the file `init.sh` serves to the webapp).
3. **Keep `release/assets/endpoints.yml` in sync** — the committed file is the reference catalog; mirror the generated entry there so the Assets tab is correct before the pipeline runs.

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

4. **Rebuild and redeploy.** Run `scripts/release_menu.sh <version>` (fails fast if the ROMs are missing) then `./wakemeup.sh -a redeploy --local`, or the one-shot `scripts/build_release.sh <version>`. The new entry appears on the next boot.

A working reference is `talos.ipxe` + `release/assets/talos/setting.sh`: the recipe mirrors `vmlinuz`/`initrd` to `<key> = talos-v1.13.8-<arch>`, and the menu boots `${mirror_endpoint}${asset_path}talos-v1.13.8-${arch}/vmlinuz` with a config-URL parameter item.
