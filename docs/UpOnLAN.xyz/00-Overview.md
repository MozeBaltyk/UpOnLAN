## UpOnLAN.xyz

With UpOnLAN.xyz I want an all-in-one solution to developp iPXE menu. A tools to help edit, serve and test iPXE menus. Extras features like Wake-on-LAN or a Documentation about iPXE developpement. 

### 🔍 Purpose

This web app aims to:
- Serve a PXE menu via iPXE with real-time edits
- Serve Assets during PXE install
- Documentation about iPXE and UpOnLAN 
- Provide logs and live system metrics (TFTP, usage, boot activity, etc.)
- Mirror menus and assets for local testing (`release/output` → `menu/` + `assets/`)
- Create and manage a diskless KVM test VM with an interactive serial console (BIOS/UEFI)
- Build serial-enabled iPXE ROMs and boot media

---

## 🔀 UpOnLAN vs netboot.xyz

UpOnLAN started as a **cold fork of [netboot.xyz](https://netboot.xyz)** — it keeps the iPXE-menu concept but is a different kind of tool.

| | **netboot.xyz** | **UpOnLAN.xyz** |
| --- | --- | --- |
| **What it is** | A public service + curated distro catalog | A self-hosted web **application** |
| **Menu model** | Generated from Jinja/Ansible templates, updated by bots | Edited in a web UI with layered local/remote overrides |
| **Asset model** | Central `endpoints.yml` + files in their `asset-mirror` repo | You build/mirror your own assets (`release/assets/` + `release_assets.sh`) and release them via your own CI |
| **Origin** | Boot against their hosted endpoint (`github.com/netbootxyz`) | You own and run the endpoint |
| **Extras** | Boot media, menu releases | Diskless KVM test VM + serial console, Wake-on-LAN, ROM builder, docs, live logs/metrics |

The shared core is the iPXE menu plus the *"extract and re-host assets, because vendors don't ship them iPXE-ready"* model — detailed in [Assets](03-Assets.md).

---

## References

* Similar project but with Vagrant:

    - [dhcp-netboot.xyz](https://github.com/samdbmg/dhcp-netboot.xyz)

* UEFI-HTTP:

    - [UEFI-HTTP Blog](https://mrguitar.net/blog/?p=2300)

    - [PXE RHEL](https://developers.redhat.com/articles/2024/08/20/bare-metal-deployments-image-mode-rhel#prepare_a_pxe_environment)

    - [UEFI-HTTP RHEL](https://developers.redhat.com/articles/2024/08/20/bare-metal-deployments-image-mode-rhel#bonus__forget_tftp_uefi_http_boot_is_better)

* Considerations:

    - [bare-metal](https://www.jimangel.io/posts/automate-ubuntu-22-04-lts-bare-metal/)

    - [iPxe DO](https://www.digitalocean.com/community/tutorials/bare-metal-provisioning-with-pxe-and-ipxe)

    - [OL8 pxeboot](https://github.com/laspavel/pxe-boot)
