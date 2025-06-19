## Summary of iPXE boot

Step & Action:   
1️⃣	DHCP assigns IP + iPXE chainload path   
2️⃣	TFTP loads iPXE binary (undionly.kpxe)   
3️⃣	iPXE fetches script via HTTP(S)   
4️⃣	iPXE executes logic (boot OS, menu, etc.)   

So in the context of the UpOnLAN.xyz webapp: 
- Provides scripts with different DHCP config and TFTP targets for testing purpose (points 1️⃣ and 2️⃣)
- Nginx server to provides the boot materials (point 3️⃣)
- Menu editor to develop those iPXE menus and build them (points 2️⃣ and 4️⃣).
- Assets handlers to Pull or Remove to serve them (point 3️⃣)
- Monitor the activity of the Webapp, Nginx and TFTP to help troubleshooting. 

In network sections, some insights on DHCP possible config are provided.

---