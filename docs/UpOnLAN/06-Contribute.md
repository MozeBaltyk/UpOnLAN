## 🤝 Contribute

Pull requests, discussions, or any other help are welcome!

There are several areas where you can contribute to this project:

- 🛠️ Maintain or add new features to the **UpOnLAN.xyz webapp**
- 🧪 Write or improve tests (Vitest pyramid in `src/webapp/test/` — see Development → Testing)
- 📚 Improve documentation to help iPXE gain popularity
- 🧪 Experiment with and provide feedback about **UpOnLAN.xyz**
- 🐳 Enhance the delivery: containers, CI/CD pipelines, Docker Hub releases, etc.
- 🔧 Develop backend functionalities like building ISOs or handling iPXE

---

## 🚀 Features

This is more of a roadmap or wish list than a finalized feature set — but it should give you a good idea of where to contribute:

- [x] Provide a **TFTP server** for PXE boot and an editor for iPXE configs
- [x] Add new actions to menu choices
- [x] Support custom endpoint URLs
- [x] Web app displays logs and live metrics
- [x] Test **PXE boot** with a KVM VM via the web console (serial console, BIOS/UEFI)
- [x] Display iPXE and UpOnLAN documentation in the web app
- [x] Build 🔄 serial-enabled iPXE ROMs and boot media (`scripts/build_ipxe_roms.sh`)
- [x] Automated test suite: webapp Vitest (unit / integration / e2e / smoke) + release specs (`tests/specs`)
- [x] Release menus, assets, and container images (`.github/workflows/{image,release,assets}.yml`)
- [ ] List **Cloud-init** assets 📝 (with a "category" column)
- [ ] Provide a fully local UpOnLAN menu (endpoint-layout assets for every entry):
  - [x] Harvester, Oracle Linux 8/9, Talos Linux, Proxmox (PBS/PMG/VE), Ubuntu (subiquity)
  - [ ] Rocky Linux (still boots `download.rockylinux.org` directly; no local recipe)
- [x] Build and publish 🔁 UpOnLAN container images via CI pipeline (`ghcr.io/mozebaltyk/uponlan`)
- [x] Provide a 🌐 **Wake-On-LAN** service with web GUI:
  - [x] Add/delete entries
  - [x] Send WOL signals
  - [ ] 🕵️ Display status/IP of hosts
  - [ ] 🗓️ Add a scheduler

---
