# UpOnLAN.xyz

**[Features](#features) • [Getting Started](docs/01-Getting-Started.md) • [PXE Basics](docs/02-PXE-Basics.md) • [Overview & netboot.xyz](docs/UpOnLAN.xyz/00-Overview.md) • [Assets](docs/03-Assets.md) • [ROM builds](docs/iPXE/03-ROM-Build.md) • [Deployment](docs/UpOnLAN.xyz/02-Deployment.md) • [CI](docs/UpOnLAN.xyz/04-CI.md) • [Operations](docs/UpOnLAN.xyz/03-Operations.md) • [Glossary](docs/Glossary.md)**

This project is a cold fork of Netboot.xyz with the goal of unifying and simplifying the upstream into an all-in-one solution. Its main purpose is to provide an editor for iPXE menus, build the boot mediums and serve them on the fly. Additional features include Wake-on-LAN, PXE menu testing and installation, and documentation in the webapp for developing custom PXE menus. 
    
PXE booting is especially relevant for automating bare-metal installations and experimenting with new setups.

## Features

This webapp aims to:
- Serve the PXE menu with real-time edits and local overrides
- Serve install assets during PXE boot
- Manage Wake-on-LAN entries
- Show logs and live metrics
- Provide built-in docs for iPXE and UpOnLAN
- Support local testing/mirroring of releases and assets
- Create and manage a diskless KVM test VM with an interactive serial console (BIOS/UEFI)
- Build serial-enabled iPXE ROMs and boot media

## Documentation goals

The documentation covers both **using and operating UpOnLAN** and the **PXE/iPXE knowledge needed to deploy it safely**. Start with [Getting Started](docs/01-Getting-Started.md), then [PXE Basics](docs/02-PXE-Basics.md) to understand the DHCP, TFTP, iPXE, HTTP, firmware, and asset flow. The remaining guides explain UpOnLAN menu editing, ROM builds, deployment, operations, and troubleshooting.

UpOnLAN serves the boot environment; it does not configure DHCP. Network-boot setup therefore requires coordinating the documented UpOnLAN service with your network's DHCP configuration and testing the correct BIOS or UEFI boot target.


## Get Started

As prerequisites:

* A `podman engine` installed.

* A libvirt installed.

* helm command

```bash
Usage: ./wakemeup.sh -a <action> [--local]

Allowed Actions
---------------
1. build - build uponlan image
2. deploy [--local] - deploy uponlan container; --local serves local menus/assets from release/output
3. destroy - destroy uponlan container
4. redeploy - redeploy uponlan container
5. logs - display logs from uponlan container
6. connect - connect to uponlan container
7. mirror-assets - build local asset output; set asset_target=<os> to build one set, e.g. asset_target=harvester ./wakemeup.sh -a mirror-assets
8. test-webapp - run webapp tests in container
9. preview - show deployment context and run preflight checks (no deploy)
10. release-menu - build the menu release (release_menu.sh) for the version in release/menus/version.ipxe
```

* 3 types of deployments:

```bash
./wakemeup.sh -a deploy               # ghcr image + GitHub assets (no build)
./wakemeup.sh -a deploy --build       # local build + GitHub assets
./wakemeup.sh -a deploy --local       # local build + local assets
```

---

## Local release and tests

Use these when you want to test without guessing:

```bash
./wakemeup.sh -a mirror-assets
./scripts/release_menu.sh 0.1.0
./wakemeup.sh -a deploy --local
./wakemeup.sh -a test-webapp
```

Release artifacts come in two layers, split under `release/output/`:
- **menu layer**: `release/output/menu/latest` + `release/output/menu/<version>/menus.tar.gz` from `release/menus/`
- **asset layer**: `release/output/assets/endpoints.yml` + `release/output/assets/<asset-key>/...` from `release/assets/`

`mirror-assets` builds the asset layer of `release/output/`.
`scripts/release_menu.sh <version>` builds the menu layer into `release/output/`.
`deploy --local` does not build the release artifacts. It serves the already prepared `release/output/` on `:8899` and deploys the Helm chart with `--local`.
`test-webapp` runs the webapp test suite inside the container.
```bash
asset_target=harvester ./wakemeup.sh -a mirror-assets
```

Use `asset_target` to build just one asset set while debugging.

`release/output/assets/endpoints.yml` is the asset catalog consumed separately from `menus.tar.gz`.
`release/output/` is the single local release layout. Its GitHub counterpart is decoupled: the menu ships as `<version>` releases and asset bundles as `<key>` releases (see [Deployment](docs/UpOnLAN.xyz/02-Deployment.md)).

See [Deployment](docs/UpOnLAN.xyz/02-Deployment.md) for remote and local deployment, ports, security, and release artifacts. See [Operations](docs/UpOnLAN.xyz/03-Operations.md) for logs, recovery, backup, and destructive-operation behavior.

## Custom iPXE ROM/media builds

Editing a served iPXE menu does not normally require a new ROM: an existing iPXE boot binary can chain to the menu. Build when the boot binary itself must embed UpOnLAN's wrapper or start a custom default boot flow, or when you need boot media for a machine that cannot use the existing network-boot path.

In the webapp, open **Menus**, expand **ROM Files**, then select **Build**. Choose the required firmware/media options, provide the site name, boot domain, and boot version, then select **Run**. The existing playbook builds the selected custom iPXE binaries and, when selected, hybrid ISO or USB image media; generated files appear in the ROM Files list. See [ROM Build](docs/iPXE/03-ROM-Build.md) for firmware and media selection guidance.
