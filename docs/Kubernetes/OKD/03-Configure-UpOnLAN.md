## Configure UpOnLAN

### HTTPS and Podman

Set `OKD_PUBLIC_BASE_URL` to a credential-free HTTPS origin: no path, query, or
fragment. DNS, certificate SAN, full chain, and target reachability must match.
For the default Podman deployment, a URL alone enables the default public OKD
pull-secret workflow; no custom secret file is required:

```sh
OKD_PUBLIC_BASE_URL='https://pxe.example.com:8443/' \
OKD_RETENTION_DAYS=0 ./wakemeup.sh -a deploy
```

Use an image containing the documented OKD implementation; `--build` builds the
current checkout rather than pulling the published image. Podman host-backs
`/config`, `/assets`, `/menu`, and `/logs`. Configure trusted TLS separately; the
self-signed fallback is not target boot acceptance. PXE iPXE trust and Agent
rootfs-fetch trust must both be established.

### Pull secret and authentication

Resolution order is **external → saved internal → public default**. The public
default is `{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}`: a documented dummy
for public OKD registries, not private registry authentication. It creates no
secret file. New/form-regenerated templates display it even if custom credentials
are configured. Custom credentials are injected only into private generation input
and are never displayed in templates or returned by status.

- **Internal:** use **Profiles → Edit → Pull Secret** for one-way Add/update.
  This shared setting requires persistent config and both `WEBAPP_USER` and
  `WEBAPP_PASS`. Existing content is never retrieved; input clears on submission.
  If acknowledgement fails, reconnect and check status before resubmitting.
- **External:** optionally set `OKD_PULL_SECRET_FILE` to an absolute readable
  regular host file when running `wakemeup.sh`. The chart mounts it read-only at
  `/run/secrets/okd-pull-secret`; only the path, not contents, is passed to Helm.
  The default mount, when present, is also authoritative. External storage cannot
  be edited through the UI. Restart after rotation.

An explicitly configured missing file, or any existing invalid/unsafe/unreadable
secret, **fails closed** rather than falling back. Custom JSON must have nonempty
`auths` with `auth` or `identitytoken` credentials; maximum size is 1 MiB. Never
paste custom credentials into profile YAML, menus, logs, or manifests.

Generation follows optional global web authentication: both web credentials enable
login for the application; absent/incomplete credentials leave it open. Authentication
is mandatory only for internal secret mutation. Configure credentials securely as
described in [Deployment](UpOnLAN.xyz/02-Deployment.md); do not reuse the pull secret.
Private/disconnected registries also need appropriate mirrors, trust, and routing.

### Kubernetes Deployment storage

Default `Deployment` storage is ephemeral and disables OKD generation. Supply all
four existing PVCs and keep one replica. Example values contain no credentials:

```yaml
deployAs: Deployment
replicas: 1
okd:
  publicBaseUrl: https://pxe.example.com/
  retentionDays: 0
  persistence:
    configClaim: uponlan-config
    assetsClaim: uponlan-assets
    menuClaim: uponlan-menu
    logsClaim: uponlan-logs
```

Create PVCs separately. For authenticated registries, optionally set
`okd.pullSecret.existingSecret` and `key` (default `.dockerconfigjson`). For web
login, use a separate `webappAuth.existingSecret` with username/password keys.
The chart does not create these secrets.

Deployment uses **Recreate** to prevent overlapping writers. Never share storage
between application instances. PVCs must permit UID/GID **911** writes to all four
directories and support `fsGroup: 911`. External secrets use group-readable `0440`;
host files must also be readable by 911 without world-read permissions. Verify
permissions with dummy data first. Kubernetes secret `subPath` rotation requires
a restart; projected symlink keys are unsupported. Stop active jobs/monitoring and
avoid active media downloads before restarting.

Previous: [Quick start](Kubernetes/OKD/02-Architecture-and-Scope.md) · Next:
[Profiles](Kubernetes/OKD/04-Profiles.md)
