## Code Architecture

```txt
├── app.js                  # Minimal bootstrapping
├── routes/
│   └── baseRoutes.js       # Contains baseurl + page routes
├── sockets/
│   └── socketHandlers.js   # Socket.IO logic
├── services/
│   ├── menuService.js      # disablesigs, getMenuVersion, etc.
│   └── dashboardService.js # builds dashboard data
├── views/
│   ├── index.ejs
│   └── uponlanxyz-web.ejs
├── public/                 # Static assets
├── package.json
```

### Why split into services/ and sockets/?

* `services/`: Pure logic that could be reused (e.g., in REST APIs later).

* `sockets/`: Glue code that maps socket events to those services.

* Pass `io` only when needed. Most handlers use just socket, but ones like config/file editing need `io for io.to(socket.id).emit(...)`.

* Security: validating file paths with `path.resolve()` and checking with `.startsWith()`. Keep that strict validation everywhere file I/O happens.

## Others notes 

* When calling an async functions: `const result = await configService.upgrademenu(version); // ✅ result is resolved value`

## Layer menu  - Why two layers?

| Directory                  | Purpose                                | Behavior / Notes                                            |
|---------------------------|-----------------------------------------|-------------------------------------------------------------|
| `/config/menus/remote/`   | Remote/base menu files                  | Fetched from GitHub or Netboot.xyz releases                 |
| `/config/menus/local/`    | Local/override menu files               | Created or edited by user via the web interface             |
| `/config/menus/`          | Merged output (remote + local overlay)  | Final menu used by the system; local files overwrite remote |

This layered model allows you to:

* Keep your custom edits separate from upstream files

* Safely update the remote menu without wiping local changes

* Automatically apply your local overrides when generating the final menu