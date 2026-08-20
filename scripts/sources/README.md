# Vendored / derived iPXE sources

Files here are vendored from, or derived for, the iPXE project
(<https://github.com/ipxe/ipxe>, GPLv2+) and are copied into the container by the
Containerfile so `scripts/build_ipxe_roms.sh` can build the ROMs and boot media.

- **`genfsimg`** — vendored from iPXE **v2.0.0** (`src/util/genfsimg`). It builds the
  hybrid BIOS/UEFI ISO and USB images for the webapp's Build UI. It is vendored
  because the pinned iPXE build version (v1.21.1) ships the older split tools
  (`geniso` / `gensdsk`) instead of the consolidated `genfsimg`. Update from
  <https://github.com/ipxe/ipxe/blob/v2.0.0/src/util/genfsimg>.

- **`ipxe-gas242-binutils.patch`** — a patch `build_ipxe_roms.sh` applies to the iPXE
  source so it builds on **binutils 2.42**, which rejects `.arch i386/i586` in
  64-bit default mode (EFI targets). It moves the `.codeXX` mode directive before
  `.arch`; the semantics of the 16/32-bit BIOS builds are unchanged.