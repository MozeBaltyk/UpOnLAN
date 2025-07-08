## Code Architecture & Design

This documentation act as a PRD (Product Requirements Document) describing the technical design, user-facing behavior, and development guidelines for the **UpOnLAN Web Application**, which provides an interface for managing iPXE boot menus, assets, and system builds via Ansible. 

---

#### 🖥️ Functional Overview

The **UpOnLAN WebApp** allows users to:

✅ Manage PXE boot menus with layered local/remote configuration       

✅ Download, update, or override assets like ISOs, kernels, and boot files       

✅ Trigger builds via Ansible playbooks to generate ROMs, ISOs, or other boot artifacts       

✅ Monitor build progress and system status in real-time via WebSockets        

✅ Access project documentation directly from the web interface      

---

#### 🏗️ Technical Components Summary

This projects includes several components :

| Component               | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| WebApp (Node.js)        | User interface + backend server logic                              |
| Menu & Assets Mirror    | Menus and assets as artifacts in the github project                |
| Ansible Playbooks       | Infrastructure automation: builds, updates, system provisioning    |
| Documentation (`/docs`) | Markdown docs rendered within the web interface                    |
| Scripts & Workflows     | Helper tools for local testing (e.g., libvirt) + GitHub automation |
 
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

## 🧱 WebApp Code Architecture

The webapp is a cold fork from Netboot.xyz, using Node.js, it was refactored following a MVC structure. 

- **Model**: Services in `/services/`
- **View**: EJS templates in `/views/`
- **Controller**: Routes and socket handlers in `/routes/` and `/sockets/`

```bash
webapp                       # The webapp code source
├── app.js                   # Web server and socket bootstrapping
├── routes/                  # HTTP routes (minimal, most logic is socket-based)
│   └── baseRoutes.js        # Contains base URL and page routes
├── sockets/                 # Socket.IO event handlers (split by domain)
│   └── socketHandlers.js    # Entry point for all socket modules
│   └── dashboardHandlers.js # Socket logic for dashboard-related events
│   └── ...                  # Other socket modules
├── services/                # Business logic layer (pure functions)
│   ├── menuService.js       # Exposes getMenuVersion(), disableSigs(), etc.
│   └── dashboardService.js  # Logic supporting dashboard metrics
│   └── ...                  # Other service files
├── views/                   # EJS templates rendered on the client
│   ├── index.ejs
│   └── uponlanxyz-web.ejs
├── public/                  # Static assets (CSS, JS, images)
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

## Ansible integration 

The WebApp container integrates Ansible and all dependencies to run ansible-playbook located in `/ansible`. So the WebApp act as an ansible-runner: 

- Builds run detached using setsid and sudo to prevent blocking the Node.js event loop

- Real-time progress is streamed via Socket.IO (buildProgress events)

- Logs are stored in `/logs/ansible/` with timestamped filenames

- Only one build runs at a time; parallel executions are blocked

- Cancellation is supported via `SIGTERM`

