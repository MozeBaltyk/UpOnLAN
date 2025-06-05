# UpOnLAN.xyz

**[Features](#features) • [Get Started](#get-started)**

This project is a cold fork of Netboot.xyz with the goal of unifying and simplifying the upstream into an all-in-one solution. Its main purpose is to provide an editor for iPXE menus and serve them on the fly. Additional features include Wake-on-LAN, PXE menu testing and installation, and a webapp for developing custom PXE menus. PXE booting is especially relevant for automating bare-metal installations and experimenting with new setups.

## Features

This webapp aims to:
- Serve a PXE menu via iPXE with real-time edits
- Serve Assets during PXE install
- Documentation about iPXE and UpOnLAN 
- Provide logs and live system metrics (TFTP, usage, boot activity, etc.)


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
7. test - pxeboot a VM on kvm domain
8. network - check kvm/podman networks info
```

---
