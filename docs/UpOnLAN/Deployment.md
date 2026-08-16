## Deployment reference

### Requirements

- A Podman engine and permission to run the `sudo podman` commands used by `wakemeup.sh`.
- Host ports `8080/TCP`, `3000/TCP`, and `69/UDP` available. Port 69 is privileged and must not be occupied by another TFTP service.
- For `deploy --local`, Python 3 plus prepared `release/output` artifacts.

### Deploy modes

```bash
./wakemeup.sh -a deploy
```

The default deployment builds `localhost/uponlan:latest` and starts `manifests/uponlan.yaml`. It obtains menus and assets from the configured remote endpoint.

```bash
./wakemeup.sh -a mirror-assets
./scripts/release_menu.sh 0.0.2
./wakemeup.sh -a deploy --local
```

Local deployment serves `release/output` with `python3 -m http.server` on port `8899` and starts `manifests/uponlan-local.yaml`. It requires `release/output/endpoints.yml` and `release/output/releases/download/0.0.2/menus.tar.gz`; it does not build either artifact.

### Security and network exposure

The shipped Nginx configuration listens on plain HTTP port `8080`; it does not provide HTTPS. The webapp is also published on `3000/TCP`, and TFTP is published on `69/UDP`.

- Restrict `69/UDP` to the PXE client network. Allow `8080/TCP` only where boot clients need HTTP assets and menus.
- Restrict `3000/TCP` to administrators, or place it behind a reverse proxy. Terminate TLS at that proxy when HTTPS is required; do not expose the shipped HTTP listener directly to untrusted networks.
- Basic authentication is disabled unless **both** `WEBAPP_USER` and `WEBAPP_PASS` are set. For a protected deployment, add both environment variables to the container in the manifest before deploying. Treat the manifest and its secret values as sensitive.

### Release artifacts

`./wakemeup.sh -a mirror-assets` runs `scripts/release_assets.sh` and recreates the asset side of `release/output`, including `endpoints.yml` and `releases/download/<asset-key>/`. Set `asset_target=<os>` to build a single asset set while debugging, e.g. `asset_target=harvester ./wakemeup.sh -a mirror-assets`.

`./scripts/release_menu.sh <version>` updates `release/menus/version.ipxe` and writes `release/output/releases/download/<version>/menus.tar.gz`. Build assets first, then the menu artifact, before using `deploy --local`.

### CLI actions

`./wakemeup.sh -a <action> [--local]` supports: `build`, `deploy`, `destroy`, `redeploy`, `logs`, `connect`, `mirror-assets`, `network`, `build-runner`, `run-runner`, and `test-webapp`. `--local` applies to `deploy`. The runner actions are optional and are not required for webapp menu builds.
