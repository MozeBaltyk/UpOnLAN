## PXE Basics

PXE starts a machine from the network rather than its local disk.

```text
PXE firmware
    | DHCP: address + boot target
    v
TFTP server -- iPXE boot program --> client
                                      |
                                      | HTTP: menu and boot/install assets
                                      v
                                  iPXE boot menu
```

### Components

- **Firmware:** the BIOS or UEFI network-boot code that begins the PXE request.
- **DHCP:** assigns network settings and identifies the boot target. It is external to UpOnLAN.
- **TFTP:** transfers the small initial iPXE boot program.
- **iPXE:** the downloaded boot program; it loads the menu and later content over HTTP.
- **Boot menu:** iPXE instructions that present choices and chain to an operating-system installer or tool.
- **HTTP server:** serves menus and larger boot/install content after iPXE starts.
- **Assets:** the kernels, initrds, installers, and other files selected by a menu entry.

### UpOnLAN's boundary

UpOnLAN manages and builds menus, serves TFTP/iPXE and HTTP menus/assets, mirrors assets, and provides Wake-on-LAN and a web interface. It does not provide or configure DHCP, and it does not make a network boot target trustworthy by itself.

### Firmware compatibility

BIOS and UEFI need compatible iPXE boot files. Configure DHCP to select the correct target for each firmware type; test both modes if both are in use.

### Trusted-network caution

PXE can deliver executable code and installation content. Use it only on trusted networks, restrict TFTP and boot HTTP to intended clients, and protect administrator access to the webapp. See [Deployment](UpOnLAN/Deployment.md) for deployment-specific ports and authentication guidance.
