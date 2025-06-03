```md
Basics of iPXE Scripting
The following commands can be implemented within an iPXE script:

* kernel – Select a kernel or boot loader that should be downloaded and executed.
* initrd – It allows you to define the initial ramdisk for download purposes.
* boot – Use it to launch the loaded kernel using the specified initrd.
* chain – It allows a script to transfer boot control to another script or bootloader.
* Flow control commands - such as *goto*, *ifopen*, and *menu-related* commands line menu, item, and choose to enable the creation of interactive decisions.
```