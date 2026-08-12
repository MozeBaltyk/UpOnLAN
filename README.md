# UpOnLAN.xyz

**[Features](#features) • [Getting Started](docs/01-GettingStarted.md) • [PXE Basics](docs/02-PXEBootBasics.md) • [ROM builds](docs/iPXE/ROM%20Build.md) • [Deployment](docs/UpOnLAN/Deployment.md) • [Operations](docs/UpOnLAN/Operations.md)**

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

## Documentation goals

The documentation covers both **using and operating UpOnLAN** and the **PXE/iPXE knowledge needed to deploy it safely**. Start with [Getting Started](docs/01-GettingStarted.md), then [PXE Basics](docs/02-PXEBootBasics.md) to understand the DHCP, TFTP, iPXE, HTTP, firmware, and asset flow. The remaining guides explain UpOnLAN menu editing, ROM builds, deployment, operations, and troubleshooting.

UpOnLAN serves the boot environment; it does not configure DHCP. Network-boot setup therefore requires coordinating the documented UpOnLAN service with your network's DHCP configuration and testing the correct BIOS or UEFI boot target.


## Get Started

As prerequisites:

* A `podman engine` installed.

* A KVM install with `virt-manager`, Not mandatory but good to have for testing purpose 

```bash
Usage: ./wakemeup.sh -a <action>

Allowed Actions
---------------
1. build - build uponlan image
2. deploy - deploy uponlan container
3. destroy - destroy uponlan container
4. redeploy - redeploy uponlan container
5. logs - display logs from uponlan container
6. connect - connect to uponlan container
7. mirror-assets - build local asset output
8. network - check kvm/podman networks info
9. build-runner - build Ansible container
10. run-runner - run Ansible container
11. test-webapp - run webapp tests in container
12. deploy --local - deploy with local menu and assets from release/output
```

---

## Local release and tests

Use these when you want to test without guessing:

```bash
./wakemeup.sh -a mirror-assets
./scripts/release_menu.sh 0.0.2
./wakemeup.sh -a deploy --local
./wakemeup.sh -a test-webapp
```

Release artifacts come in two layers:
- **menu artifact**: `release/output/releases/download/<version>/menus.tar.gz` from `release/menus/`
- **asset output**: `release/output/endpoints.yml` + `release/output/releases/download/<asset-key>/...` from `release/assets/`

`mirror-assets` builds the asset side of `release/output/`.
`scripts/release_menu.sh <version>` builds the menu artifact into `release/output/`.
`deploy --local` does not build anything. It stages config from the already prepared `release/output/` and deploys through `manifests/uponlan-local.yaml`.
`test-webapp` runs the webapp test suite inside the container.
```bash
asset_target=harvester ./wakemeup.sh -a mirror-assets
```

Use `asset_target` to build just one asset set while debugging.

`release/output/endpoints.yml` is the asset catalog consumed separately from `menus.tar.gz`.
`release/output/` is the single local/pipeline release layout.

See [Deployment](docs/UpOnLAN/Deployment.md) for remote and local deployment, ports, security, and release artifacts. See [Operations](docs/UpOnLAN/Operations.md) for logs, recovery, backup, and destructive-operation behavior.

## Custom iPXE ROM/media builds

Editing a served iPXE menu does not normally require a new ROM: an existing iPXE boot binary can chain to the menu. Build when the boot binary itself must embed UpOnLAN's wrapper or start a custom default boot flow, or when you need boot media for a machine that cannot use the existing network-boot path.

In the webapp, open **Menus**, expand **ROM Files**, then select **Build**. Choose the required firmware/media options, provide the site name, boot domain, and boot version, then select **Run**. The existing playbook builds the selected custom iPXE binaries and, when selected, hybrid ISO or USB image media; generated files appear in the ROM Files list. See [ROM Build](docs/iPXE/ROM%20Build.md) for firmware and media selection guidance.
