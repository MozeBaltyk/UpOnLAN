## 📁 iPXE Directory Structure (UpOnLAN example)

```bash
/config/
├── menus/
│   ├── main.ipxe         # Main menu entrypoint
│   ├── ubuntu.ipxe       # Submenu for Ubuntu-based boot options
│   └── tools.ipxe        # Utilities: MemTest, GParted, etc.
├── boot/
│   ├── ubuntu/
│   │   ├── vmlinuz
│   │   └── initrd.img
│   └── memtest/
│       └── memtest.efi
└── logs/
    └── tftp/
 
```