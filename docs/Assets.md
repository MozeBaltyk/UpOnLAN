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
iPXE menu (.ipxe)                endpoint catalog (endpoints.yml)
   │                                   │
   │ kernel <origin><path>vmlinuz      │ path: /releases/download/<key>/
   │ initrd  <origin><path>initrd  ←→  │ files: [vmlinuz, initrd, squashfs.img]
   │                                   │
   ▼                                   ▼
<origin> = boot HTTP origin: the local nginx root (/assets) or a GitHub release
```

1. **`endpoints.yml`** declares a boot bundle: a `path` plus the `files` served under it (kernel, initrd, rootfs, checksums...).
2. **The Assets tab** mirrors those files with *Pull Selected* (`dlremote`): each `path + file` is downloaded from the configured origin into `/assets` at the same relative path. Nginx serves `/assets` as its web root, so every mirrored file is reachable at `<boot host>:${NGINX_PORT}<path><file>`.
3. **The iPXE menu** points `kernel` / `initrd` / rootfs at exactly those URLs. The menu's `${live_endpoint}` (defined in `release/menus/boot.cfg`) is the boot origin — either the local nginx URL or a GitHub release base.

The consequence: **the path and file names in a menu must match an endpoint's `path` + `files`** in `endpoints.yml`. If they drift, the boot fails even though the assets are fully mirrored.

> ⚠️ Current state of the shipped menus: `harvester.ipxe`, `oracle.ipxe`, `proxmox.ipxe`, and `ubuntu.ipxe` still use the upstream Netboot.xyz asset layout (`/asset-mirror/releases/download/<version>-<hash>/` and vendor file names like `harvester-vmlinuz-amd64`), and `boot.cfg` defaults `live_endpoint` to `https://github.com/netbootxyz`. They therefore boot from the Netboot.xyz mirror, not from a locally mirrored bundle. Pointing them at an UpOnLAN mirror means rewriting their URLs to the endpoint layout above.

---

## ➕ Adding a New Endpoint

An **endpoint** is one entry in `endpoints.yml` that points an iPXE menu (and the Assets tab in the webapp) at a bootable bundle. The key is unique and doubles as the release tag/directory the files are served from:

```yaml
endpoints:
  oracle-9-x86_64:                     # unique key == release tag == directory
    path: /releases/download/oracle-9-x86_64/  # files are served under <mirror origin><path>
    files:
    - vmlinuz                          # kernel
    - initrd                           # initramfs
    - squashfs.img                     # rootfs (if the OS uses one)
    os: oracle                         # shown in the Assets tab
    version: '9'
    arch: x86_64
```

To add a new endpoint:

1. **Create a build recipe** at `release/assets/<os>/setting.sh`. The script is sourced by `release/assets/build.sh` and must export `OS`, `VERSION`, `ARCHS`, `BUILD_TYPE`, and `EXTRACTS` (`URL|output_file` lines, one per file, with `REPLACE_ARCH` for per-arch URLs). See `release/assets/harvester/setting.sh` for `direct_file` (download prebuilt artifacts) and `release/assets/oracle9/setting.sh` for `iso_extraction` (pull kernel/initrd/rootfs out of an ISO).
2. **Run `scripts/release_assets.sh`** — it executes every recipe and appends the generated entries to `release/output/endpoints.yml` (this is the file the webapp serves).
3. **Mirror the entry in `release/assets/endpoints.yml`** — the committed file is the reference catalog; keep it in sync with the generated output so the Assets tab is correct before the pipeline runs.

The generated endpoint key is `${OS}-${VERSION}-${GENERIC_ARCH}` (`amd64` → `x86_64`, `aarch64` → `arm64`), so one multi-arch OS produces one endpoint per architecture.
