# UpOnLAN.xyz

**[Features](#features) • [Get Started](#get-started)**

This project use Wake-on-LAN and PXEboot to automate bare-metal install in view to experiment new setup, help to develop ipxe menu and test it. It attends to be the first milestone for a homelab.

## Features

For now, this is more a roadmap or wishing list than a list of features:

[x] Provide a *TFTP server* for pxeboot and editor of ipxe config.
[] Provide a *Wake-On-LAN* service with web GUI:
    [x] Add/delete entries
    [x] Send WOL signal
    [] Get Status/IP of the hosts
    [] Scheduler
    [] Scan network
[] Custom Endpoint URL
[] *Cloud-init* listed in the Assets
[] Test *PXE boot* with a VM trigger by *Tofu*
[] Display a PXE interface with choices
[] Reachability tests
[] Build in and operated from a Container
[] Proposition of systems: Rocky8/9, Ubuntu, OL8/9, Harvester, Proxmox   

## Get Started

As prerequisites, a `podman engine` install on linux.

```bash
Usage: ./wakemeup.sh -a <action>

Allowed Actions
---------------
1. build
2. deploy
3. destroy
4. redeploy
5. logs
6. connect
```

## DEVELOP 

* code source:

```bash
tree -L 2 uponlan/src

uponlan/src
├── defaults               # Default config used by init.sh during deployement
│   ├── default
│   ├── endpoints.yml      # Yaml config with all assets endpoints (combine with env ENDPOINT_URL)
│   ├── menus              # Default menus if no url with project menus is provided 
│   └── nginx.conf
├── etc
│   └── supervisor.conf    # Config services (TFTP,)
├── init.sh                # Init script launched by start.sh
├── start.sh               # Startup script launched by the containerfile 
└── webapp                 # The webapp folder
    ├── app.js             # js function called by the .ejs 
    ├── package.json       # dependencides
    └── public             # ejs and html rendered site
```

Manifest/Containerfile map by default `./config` and `./assests`. During the init process, it provisions them.

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

[bare-metal](https://www.jimangel.io/posts/automate-ubuntu-22-04-lts-bare-metal/)
[iPxe DO](https://www.digitalocean.com/community/tutorials/bare-metal-provisioning-with-pxe-and-ipxe)
[OL8 pxeboot](https://github.com/laspavel/pxe-boot)