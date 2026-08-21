## Code Architecture & Design

This documentation act as a PRD (Product Requirements Document) describing the technical design, user-facing behavior, and development guidelines for the **UpOnLAN Web Application**, which provides an interface for managing iPXE boot menus, assets, and system builds.

---

#### 🖥️ Functional Overview

The **UpOnLAN WebApp** allows users to:

✅ Manage PXE boot menus with layered local/remote configuration

✅ Download, update, or override assets like ISOs, kernels, and boot files

✅ Build serial-enabled iPXE ROMs and boot media (via `scripts/build_ipxe_roms.sh`)

✅ Create and manage a diskless KVM test VM with an interactive serial console (BIOS/UEFI)

✅ Build ROMs and boot media (Legacy/EFI/ISO/USB) from the web app

✅ Monitor build progress and system status in real-time via WebSockets

✅ Access project documentation directly from the web interface      

---

#### 🏗️ Technical Components Summary

This projects includes several components :

| Component               | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| WebApp (Node.js)        | User interface + backend server logic                              |
| Menu & Assets Mirror    | Menus and asset bundles released to GitHub; webapp image to GHCR  |
| Documentation (`/docs`) | Markdown docs rendered within the web interface                    |
| Scripts & Workflows     | Release/build scripts (iPXE ROMs, assets, menus) + GitHub automation |
 
---

#### General Structure of the Project

`wakemeup.sh` help to kickstart the webapp using a *manifest* and *Containerfile*. It can also help to centralize in one command other scripts or be used by Github Workflows...

```bash
tree -L 2
.
├── Containerfile     # Build UpOnLAN.xyz image
├── docs              # Markdown docs displayed in the webapp
├── manifests         # K8s manifests to deploy with podman kube play or on K8s platform.
├── release           # Default menus (menus/) and asset recipes (assets/) shipped with UpOnLAN
├── scripts           # Release/build scripts: iPXE ROMs, asset mirror, menu tarball
├── src
│   ├── defaults      # Default config used by init.sh during deployment
│   ├── etc           # Config supervisor services (TFTP, nginx, webapp)
│   ├── init.sh       # Init script launched by start.sh
│   ├── start.sh      # Startup script launched by the containerfile
│   └── webapp        # The webapp source code
├── tests             # Release-flow specs (tests/specs, Python) for scripts + layout
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

## ROM / boot-media build runner

The webapp's **Build** button (Menus → ROM Files) runs `scripts/build_ipxe_roms.sh` directly — there is no Ansible. `romBuildService.js` (`/services/`) shells out to the script, which fetches the iPXE source, applies the binutils patch, enables `CONSOLE_SERIAL`, embeds the dhcp→menu chain, and `make`s the requested formats (legacy/efi/iso/usb) into `/config/menus/rom/ipxe/`.

- Builds run detached so they never block the Node.js event loop
- Real-time progress is streamed via Socket.IO (`buildProgress` events, parsed from the script's `[ipxe] ...` lines)
- Logs are stored in `/logs/rom/build_*.log`
- Only one build runs at a time; parallel executions are blocked
- Cancellation is supported via `SIGTERM` on the process group

---

## 🧪 Testing

Tests live in `src/webapp/test/` and run with **Vitest** (devDependency — not installed at runtime).

### Test pyramid

| Layer         | Path                     | What is covered                                                                  |
|---------------|--------------------------|----------------------------------------------------------------------------------|
| Unit          | `test/unit/`             | Business rules: WoL MAC validation, endpoints.yml URL derivation, nginx listen parsing, doc tree + traversal guard, TFTP log parsing, log fallbacks |
| Integration   | `test/integration/`      | Real server, real sockets, real fixture volumes: HTTP/socket auth, routes, WoL CRUD persistence, menu create/save/revert, docs listing |
| E2E           | `test/e2e/`              | Critical journeys: WoL lifecycle, PXE menu lifecycle (incl. signature disabling), unauthenticated attacker blocked |
| Smoke         | `test/smoke/`            | Boots `node app.js` like production; probes HTTP auth, socket auth and the WoL injection gate |

### How to run

```bash
# locally, from src/webapp
npm install                # once
npm test                   # all layers
npm run test:unit          # unit only
npm run test:integration   # integration only
npm run test:e2e           # journeys only
npm run test:smoke         # smoke only

# inside the container
./wakemeup.sh -a test           # tests/specs on host + full webapp suite in container
```

In CI, `.github/workflows/test.yml` runs the four webapp layers on every push/PR, plus the release-flow specs (`tests/specs`), a `bash -n` shell-lint job over `scripts/*.sh`/`src/*.sh`/`wakemeup.sh`, and a container build smoke. The release workflows are covered in [CI pipelines](UpOnLAN.xyz/04-CI.md).

### Testability notes

- Container volumes (`/config`, `/assets`, `/docs`, `/logs`) are overridable via the `UPONLAN_CONFIG`, `UPONLAN_ASSETS`, `UPONLAN_DOCS`, `UPONLAN_LOGS` env vars so tests run against fixture files with **zero mocking**.
- `app.js` exports `{ app, http, io }` and only listens when run directly (`require.main === module`), letting tests boot the server on an ephemeral port.
- `npm` is a build-only dependency in the container image (purged after install), so in-container runs invoke vitest directly: `node node_modules/vitest/vitest.mjs run`.

### Release-flow specs (Python)

The shell scripts and the `release/output` layout are covered by a separate Python `unittest` suite in `tests/specs/` (run `./tests/specs/run.sh`). These validate the release pipeline — the `menu/` + `assets/` layout, `build.sh` layouts (GitHub vs local), `release_assets.sh` targeted/untargeted behavior, `release_menu.sh` warn/missing-ROM behavior, the iPXE `asset_path` resolution (GitHub vs local), and `init.sh` / `wakemeup.sh` URL construction — against the real scripts in a temp directory with only `curl`/`sudo`/`python3` stubbed.
