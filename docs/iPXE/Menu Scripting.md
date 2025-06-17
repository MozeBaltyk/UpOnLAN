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
