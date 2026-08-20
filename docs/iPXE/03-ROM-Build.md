# ROM build

## When to build

The iPXE binary is the first executable a machine loads; the menu is content it can fetch afterwards. Therefore, changing a served menu or its assets does **not** normally require rebuilding a ROM. Reuse an existing iPXE binary when it already reaches the desired menu.

Build a custom binary when the executable must carry an embedded wrapper or a custom default boot flow. Build media when the target must start iPXE from local/removable media rather than the existing network-boot path.

## Why a VM must boot a ROM to show the menu

A common source of confusion is that the iPXE menu does not render "directly" on a libvirt VM — every boot still loads an iPXE **binary** first. The reason comes down to the difference between the *menu* and the *boot program*:

- The **menu (`menu.ipxe`, `boot.cfg`)** is a *script*: plain-text instructions (`kernel`, `initrd`, `chain`, `menu`, `item`, `choose`). It is content, not an executable.
- The **iPXE binary** is the *interpreter* that reads and runs that script. The VM firmware has no such interpreter.

On power-on the path is therefore always two stages:

```text
VM firmware (SeaBIOS / OVMF)                  no iPXE interpreter
        │
        ▼
iPXE binary (option ROM / e1000 ROM / efi)    the interpreter — DHCPs first
        │
        ▼
menu.ipxe  (TFTP or HTTP)                     the script — rendered by iPXE
```

Two QEMU/libvirt details make this unavoidable in practice:

1. **Ubuntu's QEMU ships no e1000 PXE option ROM.** The emulated NIC therefore does nothing network-wise by default — the guest never even issues a DHCP request. SeaBIOS (BIOS) has no built-in PXE client either: it delegates PXE to the NIC's option ROM. So a `<rom file=.../>` pointing at a built iPXE option ROM is required, or the BIOS guest has no network boot path at all.
2. **Stock iPXE ROMs are VGA-only.** The serial Console tab shows whatever iPXE writes to the serial port. The distro/`ipxe-qemu` binaries do not enable `CONSOLE_SERIAL`, so their menu output goes to a VGA framebuffer the serial console never sees. The ROM built by `scripts/build_ipxe_roms.sh` defines `CONSOLE_SERIAL`, which is what makes the menu text appear on the PTY serial console.

So the menu is never rendered by libvirt directly — it is rendered *by the iPXE binary* that the ROM (or the UEFI network stack) puts into the guest. The "boot on ROM" step is simply loading that interpreter; building the ROM with `CONSOLE_SERIAL` is what routes its output to the serial console.

Choose output for the target:

- **Legacy BIOS:** select Legacy disks for BIOS-compatible iPXE boot files.
- **UEFI:** select EFI disks for UEFI boot files; choose the appropriate EFI variant for the environment.
- **ISO or USB:** select Hybrid disks only when you need bootable ISO or USB image media. Hybrid output requires both Legacy and EFI selections.

## UpOnLAN release ROM build

The release pipeline builds the four iPXE artifacts the deployment consumes (BIOS option ROM, BIOS kpxe/undionly, and EFI):

```bash
./scripts/build_ipxe_roms.sh
```

Requirements: `build-essential`, `binutils` (2.42 needs `scripts/ipxe-gas242-binutils.patch` applied by the script), `liblzma-dev`/`xz-utils`, `curl`, `ipxe-qemu` (the `e1000` ROM template), and `sudo -n` for installing the host option ROM to `/usr/lib/ipxe/qemu/uponlan-e1000.rom`. `scripts/build_release.sh <version>` (or the release CI workflow) installs these and runs the build on a fresh host.

Artifacts land in `release/menus/rom/ipxe/`:
- `uponlan.xyz-e1000.rom` — SeaBIOS/BIOS option ROM (installed into the guest via `<rom file=.../>`).
- `uponlan.xyz-undionly.kpxe` / `uponlan.xyz.kpxe` — legacy BIOS PXE binaries (unused by the test-VM flow, kept for general netboot).
- `uponlan.xyz.efi` — UEFI PXE binary served to OVMF guests over TFTP.

The embedded script (`scripts/build_ipxe_roms.sh` → `embed.ipxe`) gives the binaries a serial console (`CONSOLE_SERIAL`) and a default flow: DHCP → `menu.ipxe` → `boot.cfg` → menu, with distinct recovery paths for DHCP failure, menu failure, and boot-config failure. `release_menu.sh` warns (but no longer blocks) if any of the four artifacts are missing.

## Build in the webapp

1. Open **Menus**, expand **ROM Files**, and select **Build**.
2. Select the firmware and media outputs needed, then enter the site name, boot domain, and boot version.
3. Select **Run** and wait for the build result.

The webapp runs its existing ROM-build playbook. It creates the selected custom iPXE outputs (Legacy and/or EFI) and, when selected, hybrid ISO and USB image files. The build can also generate the configured index, checksums, and signatures; completed ROM/media files are listed under **ROM Files**.
