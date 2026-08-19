# ROM build

## When to build

The iPXE binary is the first executable a machine loads; the menu is content it can fetch afterwards. Therefore, changing a served menu or its assets does **not** normally require rebuilding a ROM. Reuse an existing iPXE binary when it already reaches the desired menu.

Build a custom binary when the executable must carry an embedded wrapper or a custom default boot flow. Build media when the target must start iPXE from local/removable media rather than the existing network-boot path.

Choose output for the target:

- **Legacy BIOS:** select Legacy disks for BIOS-compatible iPXE boot files.
- **UEFI:** select EFI disks for UEFI boot files; choose the appropriate EFI variant for the environment.
- **ISO or USB:** select Hybrid disks only when you need bootable ISO or USB image media. Hybrid output requires both Legacy and EFI selections.

## UpOnLAN release ROM build

The release pipeline builds the four iPXE artifacts the deployment consumes (BIOS option ROM, BIOS kpxe/undionly, and EFI):

```bash
./scripts/build_ipxe_roms.sh
```

Requirements: `build-essential`, `binutils` (2.42 needs `scripts/ipxe-gas242-binutils.patch` applied by the script), `liblzma-dev`/`xz-utils`, `curl`, `ipxe-qemu` (the `e1000` ROM template), and `sudo -n` for installing the host option ROM to `/usr/lib/ipxe/qemu/uponlan-e1000.rom`. `ansible-playbook ansible/release_ipxe.yml` installs these and runs the build on a fresh host.

Artifacts land in `release/menus/rom/ipxe/`:
- `uponlan.xyz-e1000.rom` — SeaBIOS/BIOS option ROM (installed into the guest via `<rom file=.../>`).
- `uponlan.xyz-undionly.kpxe` / `uponlan.xyz.kpxe` — legacy BIOS PXE binaries (unused by the test-VM flow, kept for general netboot).
- `uponlan.xyz.efi` — UEFI PXE binary served to OVMF guests over TFTP.

The embedded script (`scripts/build_ipxe_roms.sh` → `embed.ipxe`) gives the binaries a serial console (`CONSOLE_SERIAL`) and a default flow: DHCP → `menu.ipxe` → `boot.cfg` → menu, with distinct recovery paths for DHCP failure, menu failure, and boot-config failure. `release_menu.sh` refuses to package the menu tarball if any of the four artifacts are missing.

## Build in the webapp

1. Open **Menus**, expand **ROM Files**, and select **Build**.
2. Select the firmware and media outputs needed, then enter the site name, boot domain, and boot version.
3. Select **Run** and wait for the build result.

The webapp runs its existing ROM-build playbook. It creates the selected custom iPXE outputs (Legacy and/or EFI) and, when selected, hybrid ISO and USB image files. The build can also generate the configured index, checksums, and signatures; completed ROM/media files are listed under **ROM Files**.
