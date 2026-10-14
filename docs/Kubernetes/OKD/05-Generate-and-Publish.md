## Generate, publish, and observe

### Generate

Save an unchanged, valid profile and wait for both exact-release tools to be
verified. **Generate** shows actionable blockers beside the button: save/reload
the profile, finish/retry tool preparation, configure persistent storage and a
valid HTTPS origin, fix invalid secret storage, or wait for another job to finish.
Check **Edit → Tools** for failures; form Save retries but replaces YAML edits.

Choose **ISO** for initial disposable acceptance or **PXE boot**, then confirm the
disk warning. The verified installer runs `agent create image` or
`agent create pxe-files` in a private workspace with the resolved pull secret.
Allow the selected release's registry/payload downloads and enough disk space.
PXE outputs include kernel, initrd, rootfs, and a rewritten immutable boot script.
ISO and PXE native generation have succeeded with synthetic DHCP lab inputs;
neither result proves target boot or installation.

Follow the job and bounded, sanitized log in **Operations**. Only one generation
job runs per application instance. Closing the browser does not stop it.
**Cancel** terminates the owned installer process, not booted hosts; it does not
roll back a cluster. Restarted unfinished jobs become `interrupted`, not resumed.

### Artifacts

Successful generation creates an immutable, checksummed version; it does not
activate it. In **Artifacts**:

- Download ISO using **HTTPS ISO**. ISO versions are not PXE-menu publishable.
- **Publish** a successful PXE version to make it active in the local OKD menu.
- **Unpublish** removes the menu pointer, **not download access**. Inactive and
  unpublished media remains reachable by direct URL.
- Select a previous version to change active media, not to roll back a cluster.
- **Delete version** requires confirmation and an inactive, unpublished version;
  private installer state and job history remain.

Agent media can contain sensitive network configuration or credentials. Directory
listing is disabled, but that is not access control. Webapp authentication does
not protect the artifact listener. Restrict it with network/firewall/ingress policy
to approved provisioning clients, even before publication.

### Optional Operations

Select a successful version before using these explicit actions:

- **Start monitoring** observes native `agent wait-for install-complete` using
  the original private workspace. It never starts automatically. Starting another
  monitor overwrites the previous bounded log; save needed evidence securely.
- **Health** queries through verified `oc` and the private kubeconfig, returning
  aggregate node/operator status, not credentials. Check expected node counts and
  operator Available/Progressing/Degraded conditions, not query success alone.
- **Run probes** checks fixed API/api-int/apps and public-origin DNS/TCP endpoints
  from the UpOnLAN server namespace. It does not prove target reachability,
  DHCP, TLS, HTTP, or a working cluster, and never gates publication.

Operations reject stale profile revisions rather than observe another cluster.
Cancellation stops observation only. Review logs before sharing: sanitization is
not a guarantee that arbitrary native output is secret-free.

Previous: [Profiles](Kubernetes/OKD/04-Profiles.md) · Next:
[Boot and verify](Kubernetes/OKD/06-Boot-and-Verify.md)
