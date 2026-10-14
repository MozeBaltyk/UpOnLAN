## Profiles

In **OKD → Profiles**, select a saved profile or choose **New**. Enter the cluster
name/base domain, exact release **5.0.0-okd-scos.1**, platform (`none` or
`baremetal`), topology, machine network, rendezvous IP, and SSH public key.
Add each host's hostname, role, MAC, reserved DHCP IP, interface, and disk hint.

Supported counts are SNO (one master, no workers), compact (three masters, no
workers), and standard (three masters plus supported worker counts, up to 20).
The platform form shows the applicable VIP fields. Save validates role counts,
unique addresses, network/rendezvous consistency, and explicit disk selection;
it does not verify external DNS/LB or contact hosts.

For the disk hint, choose **WWN**, **Serial**, or **Device name**, then enter only
the value, not a `deviceName:` prefix. Prefer WWN/serial or `/dev/disk/by-path/…`.
Conventional whole disks such as `/dev/vda`, `/dev/sda`, and `/dev/nvme0n1` are
accepted; partitions, arbitrary paths, and `/dev/disk/by-id/…` are not.
Verify physical disk identity separately; names can change.

### Save and Edit

**Save** persists the form and automatically prepares the saved release's exact
installer and `oc` in the background. **Every form Save regenerates both YAML
templates**, replacing manual YAML edits; preserve those before confirming Save.
Save retries tool preparation failures and reuses verified cache.

**Edit** has four tabs:

- **install-config.yaml** and **agent-config.yaml:** review or edit saved YAML,
  then **Save YAML**. Identity, topology, network/architecture, host roles,
  interfaces, and disk hints must match the form. Supplemental mirror, trust,
  proxy, or NTP settings still require native installer validation. Static
  NMState generation is unsupported in the current runtime.
- **Pull Secret:** shared one-way secret management, independent of Save YAML.
  Custom contents never appear in YAML. Templates accept only the exact public
  dummy or legacy `__UPONLAN_PULL_SECRET__` sentinel; old templates remain usable
  without resaving. See [configuration](Kubernetes/OKD/03-Configure-UpOnLAN.md).
- **Tools:** read-only preparing/ready/failed status and verified provenance for
  the saved release. There is no Prepare button or separate version selector.
  Save retries failures; Save YAML does not start tool preparation.

Closing Edit or disconnecting does not stop server preparation. After a restart,
the server verifies disk cache; Save restarts missing work. Opening Edit never
saves the form; save a new/changed form before editing its YAML. Pull-secret setup
remains available independently of YAML loading.

A profile cannot be deleted while artifact versions remain. Deleting a profile
does not implicitly remove private workspaces or job history.

Previous: [Configure UpOnLAN](Kubernetes/OKD/03-Configure-UpOnLAN.md) · Next:
[Generate and publish](Kubernetes/OKD/05-Generate-and-Publish.md)
