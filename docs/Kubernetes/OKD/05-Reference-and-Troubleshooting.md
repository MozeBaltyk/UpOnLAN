## Reference and troubleshooting

Return to the [four-step journey](Kubernetes/00-Overview.md) for a first install.
This page covers the media-generation service, not ongoing cluster administration.

### Find the failure before retrying

The UI order is **Profiles (Save/Edit) → Operations (Generate) → Artifacts
(results)**. Operations contains only Generate, the active generation and its
bounded log, and recent generation history. Monitoring, cluster health, DNS/TCP
probes, storage/retention cleanup, maintenance, and diagnostics are not provided.
Use target consoles and authorized native cluster tools after boot.

Keep logs and evidence private and remove credentials before sharing. Sanitization
cannot guarantee arbitrary installer output is secret-free.

| Symptom | Check / smallest next action |
|---|---|
| Generate is not ready | Open Generate for a fresh preflight. Save or reload a dirty/stale profile, wait for verified tools, configure persistent storage, fix pull-secret storage, or wait for the active generation. PXE additionally requires a valid Asset URL and resolved endpoint certificate. |
| Tools failed | Read **Edit → Tools** error and source/version/hash metadata. Check GitHub/download egress, capacity, and UID/GID 911 permissions. Form Save retries; preserve manual YAML first. Do not substitute `latest` or a PATH binary. |
| Generation failed | Read the generation log in Operations. Check payload registry access, workspace capacity, and supplemental YAML. Use DHCP; static NMState generation lacks `nmstatectl`. |
| Endpoint certificate changed | Open the profile's **Certificate details**. Compare SAN, validity, chain, and SHA-256 fingerprint. Explicitly resolve the presented-versus-stored mismatch; never bypass TLS. |
| Pull Secret save disabled | Internal changes require persistent config and both web credentials. An external source is authoritative and read-only. Check status before resubmitting after a lost acknowledgement. |
| Registry pulls fail | Verify the registry/mirror, credentials, additional CA, DNS, clock, and routing from server and nodes. Public dummy status does not verify reachability or authenticate private pulls. |
| PXE version absent from the local menu | Publish a successful finalized PXE version in **Artifacts**. ISO is download-only. Generation and bundle export do not publish automatically. |
| iPXE works, rootfs fails | Verify target reachability and the exact version's rootfs URL. `additionalTrustBundle` does not prove Agent early-rootfs private-CA support. Do not add bypasses or mix artifacts. |
| Nodes cannot join rendezvous | Verify reserved IP/MAC/NIC, VLAN/routing/return paths, live peer TCP 8090, time, and required cluster traffic. Inspect consoles; do not open all firewall ports. |
| Node reboots into Agent again | Remove ISO/virtual media and correct firmware boot order to the installed disk. Unpublishing does not change firmware. |
| Profile or version deletion blocked | Unpublish the active version first. Preserve private recovery state and backups; deleting media does not retire a cluster. |

Unfinished generation jobs become `interrupted` after restart; they are not
resumed. Closing the browser does not cancel preparation or generation. Cancel
stops only the owned installer process, not machines that already booted.

### Profile-owned media settings and trust

Each saved profile owns:

- boot mode, exactly `pxe` or `iso`;
- the final production Asset server URL used by PXE;
- explicitly confirmed endpoint CA material; and
- additional CA PEM for registry/proxy/deployment trust.

New profiles default to PXE and `https://192.168.7.1:8443/`. That address is
appropriate only when every target reaches that listener and the certificate has
the matching IP SAN. Replace it with the real final production origin otherwise.
The value is not shared between profiles and is not the OKD API, apps ingress, or
cluster `baseDomain`. ISO does not require or use it, although switching a profile
to ISO may retain its previously entered URL.

The PXE Asset URL must be a credential-free HTTPS root: no username/password,
additional path, query, or fragment. Localhost, loopback, IPv4-mapped IPv6,
unspecified, multicast, link-local, and metadata destinations are rejected.
RFC1918 IPv4 and IPv6 ULA can be used when they are genuinely reachable.

On blur and again during Save/preflight, UpOnLAN resolves the host and performs a
bounded TLS handshake without fetching arbitrary HTTP content. **Certificate
details** reports the endpoint, SAN/name match, validity, issuer/subject, chain,
system trust, and SHA-256 fingerprints. A system-trusted chain needs no copied CA.
An untrusted or self-signed endpoint requires explicit **Use inspected certificate
trust** confirmation; no certificate obtained with verification disabled is
silently trusted. The confirmed public PEM is saved with the profile. If the
presented chain later differs, PXE Save/Generate remains blocked until the operator
reviews and resolves it.

Use **+ Add CA certificate** for a PEM CA or CA bundle. Validation rejects private
keys, non-CA certificates, malformed/trailing content, invalid internal chains,
and configured size/count limits. Review parsed subjects, validity, and SHA-256
fingerprints before adding; certificates can be removed later. Explicit CAs apply
to both PXE and ISO and are merged deterministically with confirmed endpoint trust
into `install-config.yaml`'s `additionalTrustBundle`.

**Trust boundary:** `additionalTrustBundle` configures OKD/deployment trust. It
does not establish that the iPXE binary trusts the production server, and it does
not prove the exact Agent early initramfs trusts a private CA for its rootfs
download. Browser success and server-side certificate inspection are not real PXE
boot acceptance tests. Do not claim self-signed production PXE support until both
boot stages have been tested with the exact artifacts.

### Effective generation and immutable identity

**Edit** shows the saved `install-config.yaml`, including complete public
`additionalTrustBundle` PEM, and keeps the editable base `agent-config.yaml`
separate from generation-owned values. Its read-only effective preview shows:

```yaml
bootArtifactsBaseURL: https://pxe.example.com/okd/lab-okd/5.0.0-okd-scos.1/<next-media-version>
```

The preview never contains the active pull secret. At generation start, UpOnLAN
allocates a monotonic media version and writes the exact URL into the private
generation copy, for example:

```yaml
bootArtifactsBaseURL: https://pxe.example.com/okd/lab-okd/5.0.0-okd-scos.1/v1
```

The final production origin must therefore be configured **before** PXE generation.
The identity shown in status, logs, artifacts, and downloads is profile + OKD
release + media version. The release identifies the installer/release payload;
`v1`, `v2`, and so on identify immutable generations for that profile and release.
Failed or cancelled attempts can leave gaps. An allocated number is never reused
or overwritten.

Finalized public PXE files use:

```text
/okd/<profile>/<release>/vN/
```

For example:

```text
https://pxe.example.com/okd/lab-okd/5.0.0-okd-scos.1/v1/boot.ipxe
```

Changing a profile's origin does **not** rewrite finalized boot scripts, manifests,
or URLs. Existing UUID-named artifacts are legacy immutable versions and remain
readable under their recorded origin; keep that origin available or deliberately
generate and publish a new `vN`. Updating a menu pointer cannot repair URLs already
encoded in old media.

### Portable PXE bundle and production publication

A successful PXE row in **Operations → Recent generations** offers **Download PXE
bundle**. The route is behind the portal's existing authentication policy and
streams `<profile>-<release>-vN.tar.gz` without loading rootfs into memory. The
archive contains only the finalized public tree:

```text
okd/
└── lab-okd/
    └── 5.0.0-okd-scos.1/
        └── v1/
            ├── boot.ipxe
            ├── agent.x86_64-vmlinuz
            ├── agent.x86_64-initrd.img
            ├── agent.x86_64-rootfs.img
            ├── manifest.json
            └── SHA256SUMS
```

It excludes workspaces, pull secrets, kubeconfig, private keys, and logs. Verify
`SHA256SUMS`, upload the archive to the configured production HTTPS server, and
extract it **at that server's document root**. This places every file at the URL
already encoded in `boot.ipxe`; do not move files or rewrite the script. Then point
the external boot menu at the immutable entry:

```ipxe
chain https://pxe.example.com/okd/lab-okd/5.0.0-okd-scos.1/v1/boot.ipxe
```

The **Artifacts** tab remains available for checksums, authenticated ISO download,
local PXE publication/activation, rollback to an older immutable menu target, and
eligible version deletion.
The separate **Assets** page lists every verified OKD version with a copyable
**Published URL** (`boot.ipxe` for PXE, portal ISO URL for ISO). Publication only
changes UpOnLAN's local menu pointer. It does not copy an archive to an external
server, grant access, power a machine, or alter firmware boot order.

Portal authentication protects bundle/ISO downloads when configured. Public PXE
URLs at the production origin have that server's independent access policy. Agent
media can contain sensitive configuration or credentials, so restrict the origin
to approved provisioning clients, disable directory listing, retain immutable
versions needed for rollback, and include the production tree in protected backups.
Hiding a URL or unpublishing a menu entry is not revocation.

### Persistent state and backup

Persist `/config`, `/assets`, `/menu`, and `/logs`. A Kubernetes Deployment needs
four existing PVCs, one replica, UID/GID **911** write access, and `fsGroup: 911`.
The default ephemeral Deployment disables generation. Recreate rollout prevents
overlapping writers; never share writable state across application instances. See
[Deployment](UpOnLAN.xyz/02-Deployment.md).

| Content | Runtime location |
|---|---|
| Profiles and YAML templates | `/config/okd/profiles/<profile>/` |
| Verified tool cache | `/config/okd/cache/<release-digest>/` |
| Private installer state, including `auth/kubeconfig` | `/config/okd/workspaces/<profile>/<release>/vN/` |
| Generation records, sequences, and publication pointers | `/config/okd/` |
| Saved internal pull secret | `/config/okd/secrets/pull-secret` |
| Per-profile generated SSH private key, when requested | `/config/okd/keys/<profile>/id_ed25519` |
| Generation logs and audit | `/logs/okd/` |
| Finalized media | `/assets/okd/<profile>/<release>/vN/` |
| Generated local OKD menu | `/config/menus/local/okd.ipxe` |

Before upgrades or recovery, stop writes and generation and avoid active downloads.
Back up profiles/templates, original workspaces including auth, generation and
publication state, tools, logs/audit, media, menus/ROM trust, TLS material, SSH
keys, and pull secrets. Encrypt and protect backups like credentials, and test
restoration with ownership and restrictive permissions preserved. UpOnLAN no
longer provides retention cleanup or storage-maintenance actions; retire old
private state only through an authorized, separately verified procedure.

### Custom credentials and access control

Public workflows use the dummy pull secret shown in [Generate with
UpOnLAN](Kubernetes/OKD/03-Generate-with-UpOnLAN.md). It is not private-registry
authentication. Custom JSON must contain a nonempty `auths` object with credentials
and fit within 1 MiB. The active secret is injected only into the private generation
input and never appears in previews.

`OKD_PULL_SECRET_FILE` can name an absolute readable regular host file mounted at
`/run/secrets/okd-pull-secret`; when configured or present it is authoritative and
read-only in the UI. A missing, invalid, unsafe, or unreadable configured source
fails closed. Internal storage uses a `0600` file in a `0700` directory. Never make
credentials world-readable.

Both `WEBAPP_USER` and `WEBAPP_PASS` enable portal authentication; absent or
incomplete credentials leave global portal access open. Internal pull-secret
changes require both. Portal login and production PXE access control remain
separate. See [service operations](UpOnLAN.xyz/03-Operations.md) for restart and
container recovery procedures.

Start again: [1. Understand the installation](Kubernetes/OKD/01-Understand-the-Installation.md)
