# UpOnLAN.xyz

**[Features](#features) • [Get Started](#get-started)**

This project is a cold fork of Netboot.xyz with a goal unify and simplify the upstream project. It also aims to get new functionalities as Wake-on-LAN, test of the pxe menu and install, a webapp which allow to develop custom pxe menus, etc.
PXEboot is relevant to automate bare-metal installation in view to experiment new setup.

## Features

For now, this is more a roadmap or a wishing list than a list of features:

[x] Provide a *TFTP server* for pxeboot and editor of ipxe config.
[x] New Actions on Menus choices
[x] Custom Endpoint URL
[] Webapp displaying logs
[] *Cloud-init* listed in the Assets (column category)
[x] Test *PXE boot* with a VM
[x] Reachability tests
[] Build pxefile operated from the webapp
[] Proposition of systems: Rocky8/9, Ubuntu, OL8/9, Harvester, Proxmox   
[x] Provide a *Wake-On-LAN* service with web GUI:
    [x] Add/delete entries
    [x] Send WOL signal
    [] Get Status/IP of the hosts
    [] Scheduler

## Get Started

As prerequisites:

* A `podman engine` install on linux.

* `nc` package installed

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
7. test - test pxe boot with a kvm domain
8. network - check kvm/podman networks info
```

## DEVELOP 

* code source:

```bash
tree -L 2 uponlan/src

uponlan/src
├── defaults             # Default config used by init.sh during deployement
│   ├── default          # Default nginx site-confs
│   ├── endpoints.yml    # Yaml config with all assets endpoints (combine with env ENDPOINT_URL)provided 
│   └── nginx.conf
├── etc
│   └── supervisor.conf  # Config services (TFTP,nginx,webapp)
├── init.sh              # Init script launched by start.sh
├── start.sh             # Startup script launched by the containerfile 
└── webapp               # The webapp folder
    ├── app.js           # Backend with js functions. 
    ├── package.json     # dependencides
    └── public/*         # Frontend ejs/html rendered site
```

* artifacts

```bash
├── release
│   ├── assets             # Defaults assets if no endpoint url given
│   ├── menus              # Default menus if no endpoint url given
```

Manifests/Containerfile map by default `./config` and `./assests`. During the init process, it provisions them.

- `config/menus/remote`: This directory holds the "remote" or upstream versions of the iPXE menu files (e.g., after a download or upgrade).

- `config/menus/local`: This directory holds user-customized or locally edited versions.

- `config/menus/menus`: This is the "active" directory from which the TFTP or HTTP server serves the files to PXE clients.



## Sources 

* Oracle Linux:
[OL8](https://yum.oracle.com/ISOS/OracleLinux/OL8/u10/x86_64/OracleLinux-R8-U10-x86_64-boot.iso)
[OL9](https://yum.oracle.com/ISOS/OracleLinux/OL9/u5/x86_64/OracleLinux-R9-U5-x86_64-dvd.iso)


* Rocky Linux:
[Rocky8](https://download.rockylinux.org/pub/rocky/8/isos/x86_64/Rocky-8.10-x86_64-boot.iso)
[Rocky9](https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9.5-x86_64-boot.iso)


* Harvester:
[iso](https://releases.rancher.com/harvester/v1.5.0/harvester-v1.5.0-amd64.iso)
[vmlinuz](https://releases.rancher.com/harvester/v1.5.0/harvester-v1.5.0-vmlinuz-amd64)
[initrd](https://releases.rancher.com/harvester/v1.5.0/harvester-v1.5.0-initrd-amd64)
[rootfs](https://releases.rancher.com/harvester/v1.5.0/harvester-v1.5.0-rootfs-amd64.squashfs)
[squashfs](https://releases.rancher.com/harvester/v1.5.0/harvester-v1.5.0-rootfs-amd64.squashfs)


## References

* Similar project but with Vagrant:
[dhcp-netboot.xyz](https://github.com/samdbmg/dhcp-netboot.xyz)

* UEFI-HTTP:
[UEFI-HTTP Blog](https://mrguitar.net/blog/?p=2300)
[PXE RHEL](https://developers.redhat.com/articles/2024/08/20/bare-metal-deployments-image-mode-rhel#prepare_a_pxe_environment)
[UEFI-HTTP RHEL](https://developers.redhat.com/articles/2024/08/20/bare-metal-deployments-image-mode-rhel#bonus__forget_tftp_uefi_http_boot_is_better)

* Considerations:
[bare-metal](https://www.jimangel.io/posts/automate-ubuntu-22-04-lts-bare-metal/)

[iPxe DO](https://www.digitalocean.com/community/tutorials/bare-metal-provisioning-with-pxe-and-ipxe)

[OL8 pxeboot](https://github.com/laspavel/pxe-boot)