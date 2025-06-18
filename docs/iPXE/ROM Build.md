## ROM Build 

Once you developped your iPXE menu, there is a possibility to compile it with iPXE binaries with a bootlaoder wrapper.
This Bootloaders wrapper will have for purpose to dynamically handles a maximum of situation and eventually redirect at the `menu.ipxe`.

UpOnLAN.xyz provides a build button in the webapp to realize without effort this task using ansible roles and playbooks in backend.

---

## 📖 Bootloader Wrapper

Included in ansible roles, a bootloader template is propose to wrapper your custom menu iPXE. The bootloader wrapper tries to dynamically handle:

- Multiple boot protocols (TFTP, HTTP, HTTPS)

- ProxyDHCP scenarios (common in PXE setups)

- Host-specific and MAC-specific boots

- Interactive Failsafe Menu for troubleshooting

- Manual network configuration (IP, VLAN, etc.)

- IPv6 / IPv4 detection and fallback

- Error handling at each stage

It's a standard flow which can be widely use for your custom iPXE menus.

---

## High-Level Flow of the Bootloader template:

Here a small explaination about bootloader wrapper flows: 

> Start →
>  DHCP →
>    If ProxyDHCP detected → Handle next-server/proxydhcp-next-server →
>    Else → Use normal next-server
>  Try TFTP chain to local-vars.ipxe →
>    Load host or MAC-specific config if exists →
>    Else → Load default menu.ipxe from TFTP
>  Try HTTPS (or HTTP) to load menu.ipxe →
>    If fails → Try fallback (HTTP → HTTPS → localboot)
>  Failsafe Menu always available (key press or fallback)

With this bootloader, Build your own smart iPXE chainloader with:

- [x] Per-MAC or per-host config files.

- [x] Automatic DHCP vs ProxyDHCP detection.

- [x] HTTP/HTTPS fallback logic.

- [x] Fully interactive failsafe menus for debugging broken boots.

- [x] UpOnLAN can pre-generate or serve many of these iPXE scripts dynamically.

---