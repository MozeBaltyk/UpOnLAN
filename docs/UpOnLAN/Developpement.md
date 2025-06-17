## Code Architecture & Design Insights

This part is to help keeping UpOnLAN futures devs. 

This projects includes several components.

* A webapp

* A menu and Assets mirror

* Ansible playbooks to produce binaries and iso from iPXE menus.

* Documentation for all components. (The one you are currently reading)

* Scripts and Github workflows
 
---

#### General Structure of the Project

`wakemeup.sh` help to kickstart the webapp using a *manifest* and *Containerfile*. It can also help to centralize in one command other scripts or be used by Github Workflows...

```bash
tree -L 2
.
├── Containerfile     # Build UpOnLAN.xyz image
├── ansible           # Divers roles to used by webapp in backend and Github Workflows
├── docs              # Markdown docs displayed in the webapp
├── manifests         # K8s manifests to deploy with podman kube play or on K8s platform.
├── release           # Default menus and assets used in UpOnLAN.xyz
├── scripts           # Scripts to test iPXE menu through libvirt VM
├── src               
│   ├── defaults      # Default config used by init.sh during deployement
│   ├── etc           # Config supervisor services (TFTP,nginx,webapp)
│   ├── init.sh       # Init script launched by start.sh
│   ├── start.sh      # Startup script launched by the containerfile
│   └── webapp        # The webapp code source
└── wakemeup.sh       # helper to launch and test UpOnLAN.xyz
```

---

#### 🧱 Code Structure

The webapp is a cold fork from Netboot.xyz, using Node.js, it was refactored following a MVC structure. 

- **Model**: Services in `/services/`
- **View**: EJS templates in `/views/`
- **Controller**: Routes and socket handlers in `/routes/` and `/sockets/`

```bash
webapp                       # The webapp code source
├── app.js                   # Web server and socket bootstrapping
├── routes/
│   └── baseRoutes.js        # Contains base URL and page routes
├── sockets/
│   └── socketHandlers.js    # Entry point for all socket modules
│   └── dashboardHandlers.js # Socket logic for dashboard-related events
│   └── ...                  # Other socket modules
├── services/
│   ├── menuService.js       # Exposes getMenuVersion(), disableSigs(), etc.
│   └── dashboardService.js  # Logic supporting dashboard metrics
│   └── ...                  # Other service files
├── views/
│   ├── index.ejs
│   └── uponlanxyz-web.ejs
├── public/                  # Static assets (CSS, JS, icons)
├── package.json             # npm dependencies
```

---

## 🔌 Why `services/` and `sockets/`?

| Layer       | Role                                                         |
|-------------|--------------------------------------------------------------|
| `services/` | Reusable pure functions with no socket context — logic only  |
| `sockets/`  | Wiring layer: maps Socket.IO events to service logic         |

Ensure no user-provided paths are directly passed to `fs` methods — always sanitize inputs.


#### Additional Notes:

* `socketHandlers.js` registers and composes all sub-handlers.
  
* Only pass `io` to services that **require broadcasting**, e.g., `io.to(socket.id).emit(...)`.
  
* File system I/O is **strictly validated**:

  - Paths are resolved with `path.resolve(...)`

  - Only allow access to predefined roots via `.startsWith(...)` checks

  - Ensure no user-provided paths are directly passed to `fs` methods — always sanitize inputs.


> 🔐 Keep these security patterns consistent — especially when modifying files or reading logs.

---

## 🧩 Layered Menu System – Why Two Layers?

| Path                         | Description                            | Behavior / Notes                                              |
|------------------------------|----------------------------------------|---------------------------------------------------------------|
| `/config/menus/remote/`      | Remote/base menu definitions           | Pulled from GitHub or Netboot.xyz                             |
| `/config/menus/local/`       | Local user overrides                   | Created/edited via the web interface                          |
| `/config/menus/`             | Final merged output                    | Local overrides are layered on top of remote defaults         |

>
> /remote/menu.ipxe
>        ⬇
> /local/menu.ipxe (override)
>        ⬇
>       Merged → /config/menus/menu.ipxe
>

#### Benefits:
- Keeps **user customizations** safely separated from upstream content
- Supports **non-destructive updates** to remote menus
- Final menu reflects **merged content** for consistent PXE boot behavior

---
