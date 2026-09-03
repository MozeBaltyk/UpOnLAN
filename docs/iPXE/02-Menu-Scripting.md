## ✍️ iPXE Scripting

You can automate booting via simple iPXE scripts. Common commands include:

* `kernel` – Select a kernel or boot loader that should be downloaded and executed.

* `initrd` – It allows you to define the initial ramdisk for download purposes.

* `boot` – Use it to launch the loaded kernel using the specified initrd.

* `chain` – It allows a script to transfer boot control to another script or bootloader.

* Flow control:

    - `goto`, `ifopen`, `iseq` – Conditional logic

    - `menu`, `item`, `choose` – Interactive boot menus (to enable the creation of interactive decisions)

---

## Define and Use variables

```ipxe
#!ipxe
menu A Title which will display on top of your menu
item hw Hello World! 
item hb Hello Bob!
choose text_to_display && echo ${text_to_display}
```

- `item <label> <text>` : text is shown duing `menu item` display and `label` is saved into as a **setting variable**.

- `choose` define a **setting variable** `text_to_display` that it will pass futher. 

A real life example is to create a menu for Alpine:

```ipxe
#!ipxe
set local_address http://10.0.2.2:5001
set alpine_repo http://dl-cdn.alpinelinux.org/alpine/v3.15/main
:start
menu Please choose an operating system to boot
item lts   Alpine LTS
item virt  Alpine Virt
choose version
kernel ${local_address}/vmlinuz-${version} ip=dhcp alpine_repo=${alpine_repo} modloop=${local_address}/modloop-${version} initrd=initramfs-${version}
initrd ${local_address}/initramfs-${version}
boot
```

---

## Boot Process in iPXE

See Assets chapter to understand boot workflow, Here a simple example `ubuntu.ipxe` script:

```ipxe
#!ipxe
set SERVER 10.10.10.10
# Load the kernel and pass kernel parameters
kernel http://${SERVER}/boot/ubuntu/vmlinuz boot=casper netboot=nfs nfsroot=${SERVER}:/nfs/ubuntu

# Load the initial ramdisk
initrd http://${SERVER}/boot/ubuntu/initrd.img

# Boot the loaded kernel with the initrd
boot
```

> ⚠️ **Default pattern: `kernel …` + `initrd …` + `boot`.** UpOnLAN.xyz removed two legacy netboot.xyz conventions that break on this repo's pinned stock iPXE build:
> - **`md5sum` / `MD5sums`** — not a stock iPXE command; it printed `command not found` and did nothing. Do not add it back.
> - **`initrd=initrd.magic`** — on this repo's pinned iPXE `1.21.1` build it is treated as a *file to fetch* and fails with `Failed to open file: initrd.magic`. Do not use it here.

Sometimes you still need to name the initrd explicitly on the **kernel command line**. This is not an extra iPXE fetch — it is just a Linux kernel argument telling the kernel which already-loaded initrd image name to use.

That matters when the locally served initrd filename differs from the name the kernel command line should reference. Rocky is the current in-repo example: the mirror serves `/initrd`, but the loaded image is named `initrd.img` for the kernel:

```ipxe
kernel https://${SERVER}/rocky-8-x86_64/vmlinuz initrd=initrd.img inst.repo=https://download.rockylinux.org/pub/rocky/8/BaseOS/x86_64/os
initrd --name initrd.img https://${SERVER}/rocky-8-x86_64/initrd
boot
```

- `initrd=initrd.img` → Linux kernel argument
- `initrd --name initrd.img ...` → iPXE image name for the downloaded initrd
- `initrd.magic` → **not** valid for this repo's current pinned build

### HTTPS install sources and `inst.noverifyssl`

Boot assets (kernel/initrd) and the menu are served over **HTTPS only**, and the endpoint terminates TLS with a **self-signed cert** by default. iPXE is fine with that once the boot ROM embeds the deployment cert ([Deployment](UpOnLAN.xyz/02-Deployment.md)), but an **Anaconda-based installer** (Rocky/RHEL) runs its own HTTPS client when it fetches the Kickstart or a local package repo — and it has no trust path to that self-signed cert.

If `inst.ks=` (or a local `inst.repo=`) points at the self-signed endpoint, add `inst.noverifyssl` so Anaconda skips cert verification for those install sources (scoped to the installer's own fetches, not the whole menu):

```ipxe
kernel ${url}vmlinuz initrd=initrd.img inst.repo=${repo} inst.ks=${kickstart_url} inst.noverifyssl ...
```

Drop `inst.noverifyssl` once the endpoint uses a cert the installer already trusts (a real cert, or an internal CA you distribute to clients). The shipped Rocky menu already adds it on its two Kickstart paths.

Ubuntu's **cloud-init (NoCloud)** seed has **no** `inst.noverifyssl`-style flag: cloud-init verifies the TLS certificate when it fetches `user-data`/`meta-data` from `ds=nocloud-net;s=<https url>`, so a self-signed seed fails. There is no boot argument to skip that verification — the clean fixes are to serve the seed from a certificate the installer already trusts (real cert or internal CA), or to serve the provisioning seed path over plain HTTP on the trusted LAN.

## 🔗 Chain iPXE scripts

Example of chain usage with  `main.ipxe` Menu:

```ipxe
#!ipxe
set SERVER 10.10.10.10

menu iPXE Boot Menu
item ubuntu    Boot Ubuntu Live
item memtest   Run MemTest86+
item shell     Drop to iPXE Shell
choose --default ubuntu --timeout 5000 target && goto ${target}

:ubuntu
chain http://${SERVER}/menus/ubuntu.ipxe || goto failed

:memtest
kernel http://${SERVER}/boot/memtest/memtest.efi
boot || goto failed

:shell
shell

:failed
echo Boot failed. Press any key...
pause
```

> Here:
> * The chain command fetches the `ubuntu.ipxe` script seen previously.
> * `ubuntu.ipxe` contains the full kernel/initrd/boot instructions for Ubuntu.
> * If chaining fails, we go to failed using conditional logic.
> * Of course, replace 10.10.10.10 with your actual IP or use DHCP to inject it via next-server.

---

## 🧩 Provisioning URLs in shipped menus

The shipped Linux installers include canned profile items that point at the published provisioning assets via two overridable variables:

- **Rocky Linux** example Kickstart (`${kickstart_url}`):

  ```ipxe
  set params inst.ks=${kickstart_url}
  ```

- **Ubuntu Subiquity** example NoCloud seed (`${cloud_init_url}`):

  ```ipxe
  set install_params autoinstall ds=nocloud-net;s=${cloud_init_url}
  ```

Both default (in `release/menus/boot.cfg`) to the shipped example profiles under `${local_endpoint}provisioning/...`, and can be overridden in `release/menus/local-vars.ipxe` (copy `local-vars.ipxe.example`) exactly like `${local_endpoint}`.

`release/menus/rockylinux.ipxe` and `release/menus/ubuntu.ipxe` still keep their manual `read` prompt items (`Specify kickstart URL...`, `Specify preseed/autoinstall url...`). The canned entries are shortcuts to the shipped example profiles under `release/provisioning/`, which `scripts/release_menu.sh` bundles into `menus.tar.gz` and `init.sh` serves at `/provisioning/...`.

---

## ✍️ Failure handlers

In iPXE scripting, every command can fail. You can chain commands together with `||` (logical OR) to detect failures and react accordingly. This allows you to implement robust retry or fallback behavior.

```ipxe
#!ipxe
set local_address http://10.0.2.2:5001
set alpine_repo http://dl-cdn.alpinelinux.org/alpine/v3.15/main

:start
menu Please choose an operating system to boot
item lts   Alpine LTS
item virt  Alpine Virt
choose version

# Load kernel
kernel ${local_address}/vmlinuz-${version} ip=dhcp alpine_repo=${alpine_repo} modloop=${local_address}/modloop-${version} initrd=initramfs-${version} || goto load_failed

# Load initrd
initrd ${local_address}/initramfs-${version} || goto load_failed

# Attempt to boot
boot || goto load_failed

# If any command fails, jump here:
:load_failed
echo Booting failed
echo Returning to menu in 4 seconds...
sleep 4
goto start
```

---

## 🔄 Develop & test a menu live (webapp → test VM)

The fastest way to iterate is to edit a menu in the webapp and watch the diskless test VM render it on the serial console. Here is the full loop and what happens at each step.

### The two-layer menu model

The menu tree the TFTP server actually serves (`/config/menus/`) is **layered** from two source folders:

| Layer | Path | What it is |
|-------|------|------------|
| **remote** (base) | `/config/menus/remote/` | the shipped menu, extracted from `menus.tar.gz` at startup |
| **local** (override) | `/config/menus/local/` | your edits — always win over `remote` |

On every save, `layermenu()` copies `remote/` first, then `local/` on top, into `/config/menus/`. A file with the same name in `local/` therefore shadows the `remote/` one; the Menus tab labels such a file `- custom`.

### The loop

1. **Edit** — open **Menus**, click a file in the left panel (opens the ACE editor). Files marked `- custom` are your overrides; the rest are the shipped base.
2. **Save** — **Save Config** writes the file to `/config/menus/local/<file>` and re-layers it into `/config/menus/` (the TFTP root) immediately.
3. **Test** — create / power-on the test VM (**Console** tab) and watch the serial console. The chain is: OVMF network stack → `dhcp` → `chain menu.ipxe` → `boot.cfg` → `version.ipxe` → your menu.
4. **Revert** — **Revert/Delete** (only on `- custom` files) removes the `local/` override, restoring the shipped base.

> ⚠️ **Edits are instant on disk, not on a running VM.** Saving re-layers `/config/menus/` right away, but the VM fetched `menu.ipxe` **once at boot**. The on-screen countdown re-renders the *in-memory* menu — it does **not** re-fetch. To see a change, power-cycle the VM (or re-`chain`) so it pulls the fresh file over TFTP.

See [ROM Build](iPXE/03-ROM-Build.md) for why the VM must load an iPXE binary before any menu can render, [Deployment](UpOnLAN.xyz/02-Deployment.md) for the diskless test VM, and [Assets](03-Assets.md) for wiring a menu entry to its boot files.
