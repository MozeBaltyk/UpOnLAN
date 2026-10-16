## 3. Generate media with UpOnLAN

Use the completed [infrastructure checklist](Kubernetes/OKD/02-Infrastructure-Checklist.md).
The first pass is `none` + SNO + DHCP + ISO on a disposable target.

### 1. Make the server ready

Your UpOnLAN installation needs persistent `/config`, `/assets`, `/menu`, and
`/logs`. Follow [Deployment](UpOnLAN.xyz/02-Deployment.md) for installation,
ports, persistence, and admin authentication. The portal on port 3443 is for
people and authenticated downloads; a production PXE origin is configured on the
profile before generation and may be a different HTTPS server.

### 2. Create and Save a profile

1. Open **OKD → Profiles → New**.
2. Enter profile ID `lab-sno`, cluster name `lab`, base domain `example.com`, and
   pinned release **5.0.0-okd-scos.1**. Replace documentation values with your plan.
3. Select platform **none**, topology **sno**, and **0** workers. Set machine CIDR
   and rendezvous IP, for example `192.0.2.0/24` and `192.0.2.10`.
4. Enter your real SSH **public** key. Add `master-0` as the control-plane host,
   its actual MAC, reserved DHCP IPv4, and live NIC name.
5. Choose disk hint type **Serial** and enter the actual verified serial as the
   value. `<VERIFIED_DISK_SERIAL>` is a reminder, not an installable disk identity.
   Do not prepend `serial:` in the value box. WWN and supported whole-device/by-path
   names are alternatives; stable serial/WWN is safer than changing device names.
6. In **Installation media**, choose the profile's boot mode. New profiles default
   to **PXE boot** and Asset server URL `https://192.168.7.1:8443/`. For PXE,
   replace that default with the final production credential-free HTTPS root unless
   it is genuinely reachable by the targets. ISO neither requires nor uses it.
7. For PXE, leave the Asset URL field to run endpoint inspection. Open
   **Certificate details** and review name/SAN, validity, chain, trust, and SHA-256
   fingerprint. If it is untrusted, explicitly choose **Use inspected certificate
   trust**; UpOnLAN never silently accepts a certificate obtained without trust.
8. If OKD must trust private registry or proxy CAs, use **+ Add CA certificate**,
   paste public CA PEM, validate it, and review the parsed subjects, validity, and
   fingerprints. These profile-owned CAs apply to both ISO and PXE. Never paste a
   private key.
9. Choose **Save**. This creates or updates the profile, regenerates **both YAML
   files**, and automatically starts exact-release installer **and `oc`** download/
   verification in the background. It does not contact or install the target.

On an existing profile, the Save prompt warns that manual YAML edits will be
replaced, including mirror/NMState settings. Preserve needed edits before
confirming, then reapply and review them. Closing the browser does not stop server
tool preparation. There is no separate Tools button, Prepare action, or tool
version dropdown.

### 3. Open Edit and review four tabs

Save a new/changed form **before** opening **Edit**; Edit does not save it for you.

| Tab | What to do |
|---|---|
| **install-config.yaml** | Review cluster domain, topology, machine network, platform, and SSH public key. |
| **agent-config.yaml** | Review rendezvous, each host's role/MAC/NIC, and installation disk hint. The read-only effective-generation preview shows the final PXE path with `<next-media-version>`; generation replaces it with the allocated `vN`. |
| **Pull Secret** | Check the shared credential source/status; add custom registry auth only if needed. |
| **Tools** | Wait for both tools to be Ready and verified. Read errors and version/source/hash metadata here. |

For the public DHCP lab, generated YAML normally needs no manual edits. Change
safety-critical settings (identity, topology, network, roles, interfaces, disks,
SSH key) **in the form**, then Save, rather than trying to override them in YAML.
**Save YAML** saves the two templates; it does not prepare tools or save a secret.

Expert supplemental mirror, CA trust, proxy, and NTP settings may be edited in
YAML within the accepted fields. Native installer validation still applies.
The generated `install-config.yaml` includes the profile's endpoint trust and
explicit additional CAs in `additionalTrustBundle`. The editable base
`agent-config.yaml` does not own `bootArtifactsBaseURL`; UpOnLAN injects the exact
immutable URL into the private generation copy. Previews never reveal the active
pull secret.
Static NMState generation is **unsupported** because this runtime lacks
`nmstatectl`; accepted expert YAML is not a promise that generation will work.
For tool failures, fix egress/storage/permissions, then **form Save** retries
preparation, reusing verified cache. Remember that form Save replaces YAML edits.

### 4. Choose public or private registry access

**Public OKD:** no Red Hat registration or real catalog credential is needed for
the public release workflow. Leave the built-in public placeholder in templates:

```json
{"auths":{"fake":{"auth":"aWQ6cGFzcwo="}}}
```

That exact dummy JSON is not authentication for a private registry. Its status
does not prove the target can reach any registry; verify actual access separately.

**Private/disconnected:** use **Edit → Pull Secret** to Add/update full registry
auth JSON, not just a token string. Internal saving requires persistent config
and **both** `WEBAPP_USER` and `WEBAPP_PASS` configured for admin login. Existing
secret contents are never revealed; the input clears after submission. This
setting is shared across profiles, not local to the current one.

Resolution is **external file → saved internal secret → public default**. External
credentials are read-only in the UI. An invalid existing/configured secret fails
closed rather than silently falling back. New/form-regenerated YAML still displays
the public dummy; actual custom auth is injected only into private generation
inputs. Do not paste real credentials into YAML, menus, or logs. Base64 `auth` is
encoding, **not encryption**. See the [reference](Kubernetes/OKD/05-Reference-and-Troubleshooting.md)
for rotation and recovery. Secret saving and YAML saving are independent actions.

### 5. Generate and inspect the result

1. Switch from **Profiles** to **Operations → Generate installation media**.
   Operations contains only this Generate card, the active generation/log, and
   recent generation history. **Artifacts** remains a separate tab.
2. Check the card's profile, saved mode, release, and destination. The saved
   profile decides whether the button says **Generate PXE** or **Generate ISO**;
   there is no second format choice. Clicking it opens a popup that runs an
   automatic preflight:
   - With **no errors or warnings**, generation **starts immediately** — there is
     no separate confirm button. The popup reports
     "Checks passed — starting generation…".
   - Otherwise it lists what to fix (unsaved/stale profile, tools still preparing,
     persistence, credentials, an active job, or — for PXE only — the Asset URL
     and endpoint certificate). Fix it and reopen Generate.
   The two checks share a 15-second timeout; a lost acknowledgement may mean the
   job already started, so check status before retrying.
3. There is no second confirmation, so review the profile, mode, release, and
   destination **before** you click. The server repeats full preflight, allocates
   the next profile/release media version, then injects the final production URL
   into the private PXE `agent-config.yaml`. Generation runs on the server and
   does not itself boot a machine. Start errors stay in the same popup.
4. Watch the same card for job state/timestamps and **Generation log** (bounded and sanitized). One
   generation job runs per application instance. Closing the page does not stop
   it; **Cancel** stops the owned generation process, not booted nodes.
5. On success, choose **View artifacts** (or the **Artifacts** tab) to review the
   finalized, immutable version. Check the release, profile revision, artifact
   list, and recorded checksums. The separate **Assets** page also lists every
   verified OKD version (profile, version, mode, state) with a **Published URL**
   you can copy: the `boot.ipxe` URL for PXE, or the portal ISO URL for ISO.

Unsaved/new forms cannot generate an older saved revision: return to **Profiles**
to save/edit first. Switching tabs preserves the draft. Failed or cancelled jobs
can consume a `vN`; gaps are expected and allocated versions are never reused.

| Result | Next action |
|---|---|
| ISO | Use **Download ISO** through the portal's existing authentication policy, with no Asset URL required. The separate asset listener denies ISO files. Attach full ISO (includes rootfs) as virtual media or write it using your approved media procedure. ISO is not PXE-menu publishable. |
| PXE | Public files use `/okd/<profile>/<release>/vN/`. **Download PXE bundle** from recent history, or review/publish it in Artifacts. The authenticated tar.gz contains that complete `okd/.../vN/` tree, including `boot.ipxe`, kernel, initrd, rootfs, `manifest.json`, and `SHA256SUMS`. |

Publication changes a **menu pointer**, not a machine's power or boot order.
**Unpublish** removes that pointer, not direct URL access; unpublished media still
needs access restrictions. Selecting an older version changes offered media, not
an installed cluster. Never treat menu publication as authorization or revocation.

For an external production origin, copy the authenticated archive to that server
and extract it at the HTTPS document root. The resulting
`okd/<profile>/<release>/vN/` path must match the URLs already encoded in
`boot.ipxe`; do not edit the script after generation. Verify `SHA256SUMS`, restrict
the production server independently of portal login, and chain:

```ipxe
chain https://pxe.example.com/okd/lab-sno/5.0.0-okd-scos.1/v1/boot.ipxe
```

**Ready output:** a known artifact version and its checksums, with ISO downloaded
or PXE deliberately published. Installation has not happened yet.

Previous: [2. Infrastructure](Kubernetes/OKD/02-Infrastructure-Checklist.md) ·
Next: [4. Boot and verify](Kubernetes/OKD/04-Boot-and-Verify.md)
