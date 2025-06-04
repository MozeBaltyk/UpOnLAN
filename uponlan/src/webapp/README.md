# UpOnLAN Web App – Code Architecture & Design Insights

## 🧱 Code Structure

```txt
├── app.js                   # Minimal bootstrapping
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
├── package.json
```

## 🔌 Why `services/` vs `sockets/`?

| Layer       | Role                                                         |
|-------------|--------------------------------------------------------------|
| `services/` | Reusable pure functions with no socket context — logic only |
| `sockets/`  | Wiring layer: maps Socket.IO events to service logic         |

### Additional Notes:
- `socketHandlers.js` registers and composes all sub-handlers.
- Only pass `io` to services that **require broadcasting**, e.g., `io.to(socket.id).emit(...)`.
- File system I/O is **strictly validated**:
  - Paths are resolved with `path.resolve(...)`
  - Only allow access to predefined roots via `.startsWith(...)` checks

> 🔐 Keep these security patterns consistent — especially when modifying files or reading logs.

---

## 🧩 Layered Menu System – Why Two Layers?

| Path                         | Description                           | Behavior / Notes                                              |
|------------------------------|----------------------------------------|---------------------------------------------------------------|
| `/config/menus/remote/`      | Remote/base menu definitions           | Pulled from GitHub or Netboot.xyz                             |
| `/config/menus/local/`       | Local user overrides                   | Created/edited via the web interface                          |
| `/config/menus/`             | Final merged output                    | Local overrides are layered on top of remote defaults         |

### Benefits:
- Keeps **user customizations** safely separated from upstream content
- Supports **non-destructive updates** to remote menus
- Final menu reflects **merged content** for consistent PXE boot behavior

---

## 🔍 Purpose

This web app aims to:
- Serve a PXE menu via iPXE with real-time edits
- Serve Assets during PXE install
- Documentation about iPXE and UpOnLAN 
- Allow file, log, and network control via browser
- Provide live system metrics (TFTP, usage, boot activity, etc.)
