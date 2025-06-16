## 🧭 Getting Started with iPXE

**iPXE** is an open-source network boot firmware that allows computers to boot over the network using protocols like HTTP, iSCSI, or TFTP.

This guide helps you get started with the basics of writing and serving iPXE boot scripts.

---

## 🔧 What You Need

- A **DHCP server** (e.g. `dnsmasq`, already included in KVM) that can point to your TFTP and HTTP boot files.

- A **TFTP/HTTP server** (e.g. `dnsmasq`, `nginx`, or `python3 -m http.server`)

- A **working iPXE binary** (e.g. `undionly.kpxe` or `ipxe.efi`) 
 
See setup snippet below:
  
```bash
# KVM TFTP
if [ -f /etc/debian_version ]; then
    # iPXE
    sudo apt-get install -y ipxe
    sudo mkdir -p /var/lib/tftpboot/
    sudo cp /usr/lib/ipxe/ipxe.pxe /var/lib/tftpboot/
    sudo cp /usr/lib/ipxe/undionly.kpxe /var/lib/tftpboot/undionly.0
    sudo chown -R nobody:nogroup /var/lib/tftpboot
    sudo chmod -R 777 /var/lib/tftpboot
elif [ -f /etc/redhat-release ]; then
    # iPXE
    sudo yum install -y ipxe-bootimgs
    sudo cp /usr/share/ipxe/ipxe-x86_64.efi /var/lib/tftpboot/
    sudo cp /usr/share/ipxe/undionly.kpxe /var/lib/tftpboot/undionly.0
    sudo chown -R nobody:nobody /var/lib/tftpboot
    sudo chmod -R 777 /var/lib/tftpboot
fi
```

Bootable system images (ISO, kernel/initrd, etc.)

---

## ✍️ iPXE Scripting

You can automate booting via simple iPXE scripts. Common commands include:

* `kernel` – Select a kernel or boot loader that should be downloaded and executed.

* `initrd` – It allows you to define the initial ramdisk for download purposes.

* `boot` – Use it to launch the loaded kernel using the specified initrd.

* `chain` – It allows a script to transfer boot control to another script or bootloader.

* Flow control:

    - `goto`, `ifopen`, `iseq` – Conditional logic

    - `menu`, `item`, `choose` – Interactive boot menus (to enable the creation of interactive decisions)


### 🔗 Sample `ubuntu.ipxe` Script

```ipxe
#!ipxe
set SERVER 10.10.10.10
kernel http://${SERVER}/boot/ubuntu/vmlinuz boot=casper netboot=nfs nfsroot=${SERVER}:/nfs/ubuntu
initrd http://${SERVER}/boot/ubuntu/initrd.img
boot
```

### ✍️ A Simple `main.ipxe` Menu

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

Replace 10.10.10.10 with your actual IP or use DHCP to inject it via next-server.

---

## 📚 More Resources


- 📘 [iPXE official documentation](https://ipxe.org)

- 💡 [Script syntax guide](https://ipxe.org/scripting)

- 🔗 [Chainloading](https://ipxe.org/howto/chainloading)
