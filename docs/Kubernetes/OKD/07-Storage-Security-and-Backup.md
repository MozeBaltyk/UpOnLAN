## Storage, security, and backup

Persist `/config`, `/assets`, `/menu`, and `/logs`; Deployment mode needs all four
PVCs, one replica, and UID/GID 911 access. See [configuration](Kubernetes/OKD/03-Configure-UpOnLAN.md).

| Content | Location |
|---|---|
| Profiles and YAML | `/config/okd/profiles/<profile-id>/` |
| Verified tools | `/config/okd/cache/<release-digest>/` |
| Private installer state and auth | `/config/okd/workspaces/<profile-id>/<job-id>/` |
| Jobs, monitor state, publication pointers | `/config/okd/` |
| Internal custom pull secret | `/config/okd/secrets/pull-secret` |
| Job/monitor logs and audit | `/logs/okd/` |
| Public-sensitive media | `/assets/okd/<profile-id>/<version-id>/` |
| Generated local menu | `/config/menus/local/okd.ipxe` |

Private workspaces and secrets are filesystem-only. Internal secrets use `0600`
files in a `0700` directory. Public Agent media can contain sensitive configuration
or credentials: restrict artifact access independently of webapp login. Unpublish
does not revoke downloads.

Before upgrades/recovery, stop writes and active observation/downloads. Back up
profiles/templates, original workspaces **including auth/kubeconfig**, job/monitor
state, publication pointers, tools, logs/audit, menus/ROM trust, TLS keys, secrets,
and media. Encrypt/protect backups like credentials and test restoration with
ownership and restrictive permissions preserved.

Keep `OKD_RETENTION_DAYS=0` during acceptance. Positive retention identifies only
old failed/cancelled/interrupted jobs without protected media or monitor references;
cleanup requires confirmation. Successful/version-bearing and monitor-selected
workspaces remain protected even when unpublished. Removing versions/profiles does
not authorize deletion of private recovery state; retire that manually only after
verified backup and confirmation it is no longer needed.

Profile/YAML writes handle caught errors, but are not power-failure atomic. After
an abrupt interruption, preserve the whole affected directory including hidden
backup files, then restore a verified consistent profile/install/agent set. Never
mix revisions or accept partially written state.

Previous: [Boot and verify](Kubernetes/OKD/06-Boot-and-Verify.md) · Next:
[Troubleshooting](Kubernetes/OKD/08-Troubleshooting.md)
