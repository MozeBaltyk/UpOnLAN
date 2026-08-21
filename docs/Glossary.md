## Glossary

Quick reference for the terms used across the docs. Grouped by theme; each entry is a definition, not a how-to.

## Boot fundamentals

- **PXE** — *Preboot eXecution Environment*. A standard (Intel, 1999) that lets a NIC fetch a boot program over the network using **DHCP** (to get an address + the boot-file pointer) then **TFTP** (to fetch it). The original, limited predecessor to iPXE.
- **iPXE** — an open-source bootloader that extends PXE. It can boot over HTTP(S), run iPXE **scripts**, and chain to a menu. The interpreter UpOnLAN's whole menu depends on.
- **TFTP** — *Trivial File Transfer Protocol* (UDP/69). Delivers the initial boot binary; iPXE then switches to HTTP for speed.
- **DHCP** — *Dynamic Host Configuration Protocol* (UDP 67/68). Hands the client an IP and, for PXE, the boot file to load.
- **next-server / filename** — DHCP options 66/67: the TFTP server address and the boot-file path a PXE client should fetch.
- **dhcp-boot / dhcp-match** — dnsmasq directives that set the bootfile per client tag (`ipxe-bios`, `ipxe-efi`, `uefi-fw`).
- **option 93 / option 175** — DHCP client-architecture (option 93, e.g. `7` = UEFI x86-64) and iPXE's vendor option (175) used to pick the right bootfile per firmware.
- **option ROM** — a firmware extension a BIOS NIC loads at boot that provides the PXE client (e.g. the built e1000 iPXE ROM).
- **chain / chainloading** — an iPXE command that loads and hands off control to another program or script (`chain menu.ipxe`).
- **BIOS / SeaBIOS** — legacy x86 firmware; a BIOS guest PXE-boots via a NIC **option ROM**.
- **UEFI / OVMF** — modern firmware (OVMF = TianoCore's open UEFI for QEMU); UEFI has a native network boot stack driven by `dhcp-boot`/option 67.
- **CONSOLE_SERIAL** — an iPXE build option that routes its text output to the serial port, so the menu renders on a serial console rather than VGA only.

## Boot artifacts and formats

- **vmlinuz** — the Linux kernel image.
- **initrd / initramfs** — the early-boot filesystem loaded before root; brings up devices and the network.
- **rootfs / squashfs** — the compressed read-only root filesystem of a live system.
- **.kpxe / .undionly.kpxe** — iPXE images for BIOS PXE (`undionly` = uses the NIC's UNDI driver).
- **.efi / -snp.efi / -snponly.efi** — UEFI iPXE binaries (`snp` = Simple Network Protocol; `snponly` = stripped to SNP only).
- **.dsk / .pdsk** — floppy / partitioned-disk images (BIOS).
- **.lkrn** — iPXE packaged as a Linux-kernel-format image, bootable via GRUB/syslinux/QEMU `-kernel`; also the input `genfsimg` uses.
- **.iso / .img** — hybrid BIOS+UEFI bootable CD/DVD / USB images assembled by `genfsimg`.
- **genfsimg** — an iPXE utility that builds hybrid ISO/USB media from a `lkrn` (BIOS) + an `efi` (UEFI) binary.
- **boot.iso / install.img** — the small network-boot ISO and the Anaconda stage-2 installer image (the pieces worth extracting from a vendor DVD).

## iPXE menu and scripting

- **iPXE script** — plain-text instructions (`menu.ipxe`, `boot.cfg`, `<os>.ipxe`) the iPXE binary interprets; content, not an executable.
- **item / choose / goto / label** — the iPXE commands that build a menu and route selection to a `:label` block.
- **kernel / initrd / boot** — iPXE commands to load a kernel + initrd and boot them.
- **ipparam / cmdline** — extra kernel command-line parameters appended to a boot.

## UpOnLAN asset model

- **endpoint** — one entry in `endpoints.yml`: a `<key>`, a `path`, and the `files` served under it — a bootable bundle's contract.
- **endpoints.yml** — the catalog the webapp/`init.sh` reads to know which asset bundles exist and where.
- **endpoint key** — `<os>-<version>-<arch>`; the unique id that doubles as the GitHub release tag and the directory the files are served from.
- **asset / asset bundle** — the re-hosted boot files (kernel/initrd/rootfs/ISO) for one endpoint.
- **direct_file / iso_extraction** — the two `BUILD_TYPE`s: download files verbatim vs extract them out of a vendor ISO.
- **mirror_endpoint** — the boot origin for your mirrored assets (default your GitHub repo; overridden locally).
- **live_endpoint** — the legacy netboot.xyz origin (now unused).
- **asset_path** — the path prefix: `/releases/download/` on GitHub, `/` on a local nginx mirror.
- **mirror-assets** — the `wakemeup.sh` action that runs `release_assets.sh` to build `release/output/assets/`.
- **local-vars.ipxe** — a per-deployment override of `mirror_endpoint`/`asset_path`; never baked into a release tarball.
- **release/output** — the local build output (`menu/` + `assets/`), the source for `deploy --local`.
- **GHCR** — *GitHub Container Registry*, where the UpOnLAN container image is published (`ghcr.io/…/uponlan`).

## Deployment

- **deploy modes** — `deploy` (pull the ghcr image + GitHub assets), `--build` (build the local image), `--local` (serve `release/output` and point the menu at it).
- **preview / preflight** — show the resolved deployment context and run checks (ports free, `podman`/`helm` present, libvirt socket) without deploying.
- **Podman / play kube** — the container engine and its command that runs a Kubernetes YAML pod (fed here by `helm template`).
- **Helm chart** — `charts/uponlan/`, the templated deployment manifest (`values.yaml` + `pod.yaml`).
- **KVM / libvirt / virsh** — the hypervisor stack the webapp's VM console controls over `qemu:///system` and the mounted `/var/run/libvirt/libvirt-sock`.
- **diskless** — a guest with no virtual disk; it PXE-boots and runs entirely in RAM.
- **serial console / PTY** — the text console the webapp attaches to (`virsh console --force`), where the iPXE menu and OS output appear.

## cloud-init

- **cloud-init** — the de-facto tool that provisions a machine on first boot from a config; handles hostname, users/SSH keys, network, packages, and run-commands.
- **datasource** — the mechanism cloud-init uses to discover its config (NoCloud, EC2, VMware, …).
- **NoCloud** — the datasource for bare-metal/local; reads its seed from a local config drive or an HTTP URL.
- **nocloud-net** — the legacy name for NoCloud-over-HTTP; folded into NoCloud with `ds=nocloud;s=URL` in modern cloud-init.
- **seed / seedfrom (`s=`)** — the disk or URL cloud-init reads its `user-data` + `meta-data` from.
- **user-data** — the cloud-init config itself (users, SSH keys, packages, `runcmd`, …).
- **meta-data** — instance identity (hostname, `instance-id`).
- **network-config** — optional cloud-init network configuration.
- **config drive / cidata** — a disk/ISO labeled `cidata` carrying `meta-data` + `user-data`.
- **ds=nocloud;s=URL** — a kernel command-line argument telling cloud-init to fetch its seed over HTTP — the standard way to pair cloud-init with PXE.

## Installer / first-boot tooling

- **Anaconda** — the RHEL/Rocky/Fedora family installer; driven by `inst.repo` and a stage-2 `install.img`.
- **inst.repo=** — an Anaconda kernel argument pointing at the package repository (kept vendor-direct in UpOnLAN menus).
- **dracut** — the initramfs framework behind the RHEL/Rocky family's early boot.
- **Casper** — Ubuntu's live-system boot hook.
- **debian-installer (d-i)** — the classic Debian/Ubuntu installer.
- **subiquity** — Ubuntu's newer server installer (used by the UpOnLAN `ubuntu.ipxe` entry).

## Networking / misc

- **Wake-on-LAN (WOL)** — sending a magic packet to power on a machine by MAC address.
- **Ports** — `69/UDP` TFTP, `67-68/UDP` DHCP, `80/443 TCP` HTTP(S), `8080`/`3000` the UpOnLAN asset/www listeners.