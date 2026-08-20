## 🧭 Getting Started with iPXE

**iPXE** is an open-source network boot firmware that allows computers to boot over the network using protocols like HTTP, iSCSI, or TFTP.

This guide helps you get started with the basics of writing and serving iPXE boot scripts.

---

## 🔧 The Basic to start

- A **DHCP server** (e.g. `dnsmasq`, already included in KVM) that can point to your TFTP and HTTP boot files.

- A **TFTP/HTTP server** (e.g. `dnsmasq`, `nginx`, or `python3 -m http.server`)

- A **working iPXE binary** (e.g. `undionly.kpxe` or `ipxe.efi`) 
 
- iPXE binaries, see bash snippet below in which we get the ipxe package and copy the minimum binaries needed:
  
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

- Some Bootable system images (ISO, kernel/initrd, etc.)

- Then develop your ipxe menu...

> NB: It can be only one TFTP using 69 port. So if local KVM config is tested and not removved afterward,
> you may get a conflict with uponlan webapp which will also try to use port 69.  


---

## 📚 More Resources


- 📘 [iPXE official documentation](https://ipxe.org)

- 🧭 [Script syntax guide](https://ipxe.org/scripting)

- 🔗 [Chainloading](https://ipxe.org/howto/chainloading)

- 💡 [Blog](https://medium.com/@peter.bolch/how-to-netboot-with-ipxe-23a042039a3c)