# UP on LAN

**[Features](#features) • [Get Started](#get-started)**

This project use Wake-on-LAN and PXEboot to automate bare-metal install in view to experiment new setup. It attends to be the first milestone for a homelab.

## Features

For now, this is more a roadmap or wishing list than a list of features:

[] Provide a *Wake-On-LAN*
[] Provide a *PXE server*
[] Provide services like *dnsmasq*, *http server*, etc.
[] Automated bare-metal install with *PXE boot*
[] Provisioning with *Cloud-init* templates
[] Display a PXE interface with choices
[] Reachability tests
[] Build in and operated from a Container
[] Proposition of systems: Rocky8/9, Ubuntu, OL8/9, Harvester   

## Get Started



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
[OL8 pxeboot](https://github.com/laspavel/pxe-boot)