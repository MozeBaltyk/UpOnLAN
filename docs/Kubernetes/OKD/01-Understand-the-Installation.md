## 1. Understand the installation

### Kubernetes, OKD, and OpenShift

Kubernetes schedules and runs container workloads. **OKD** is a community
distribution of Kubernetes with an integrated operating system, networking,
authentication, application routes, web console, and Operators that manage cluster
components. It shares source with Red Hat OpenShift Container Platform (OCP);
it is not the commercial OCP product or its support entitlement.

An OKD install creates a whole platform, not just a Kubernetes API process.
Plan DNS, network access, disk performance, and capacity before making media.

### The primary idea: you describe a cluster, then boot nodes that become it

An OKD installation is declarative. You never "install OKD" onto a machine by
hand. You write down two things:

- `install-config.yaml` — what the cluster is: name, base domain, platform,
  networking, SSH public key, and the pull secret used to fetch container images.
- `agent-config.yaml` — which machines become nodes: the rendezvous IP and, per
  host, its role, NIC/MAC, and the disk to install onto.

The installer turns those two files into **boot media**. The real work begins
when the declared machines boot: they enter a live Agent environment, find each
other through the rendezvous host, validate the plan, install the OS onto their
disks, and run bootstrap **inside those nodes**. Media is inert; the nodes build
the cluster.

### The default installation, without UpOnLAN

OKD has three methods. Installer-provisioned infrastructure is cloud-only.
User-provisioned infrastructure (UPI) is fully manual and adds a temporary
bootstrap machine. The default for bare metal / platform `none` — and the only
method UpOnLAN drives — is the **Agent-based installer**. Done by hand it is:

1. Pick **one exact release**. Download its `openshift-install` and `oc`
   tarballs, extract them, and verify the checksums. Never mix releases.
2. Create a working directory and write `install-config.yaml` in it: cluster
   name, base domain, platform, machine network, SSH public key, pull secret.
3. Write `agent-config.yaml` in the same directory: rendezvous IP plus one
   `hosts[]` entry per node (role, interface name + MAC, `rootDeviceHints`).
4. Produce media with that installer:
   `openshift-install agent create image --dir <dir>` for a full
   `agent.x86_64.iso`, or `openshift-install agent create pxe-files --dir <dir>`
   for a kernel/initrd/rootfs tree plus a boot script.
5. Deliver the media yourself: attach or write the ISO, or serve the `pxe-files`
   tree over **HTTPS** and chain the boot script from your own DHCP/iPXE setup.
6. Boot every declared node once (next section: what the nodes then do).
7. On an admin host, run the same installer against the same directory:
   `openshift-install agent wait-for bootstrap-complete --dir <dir>`, then
   `... agent wait-for install-complete --dir <dir>`.
8. Recover `<dir>/auth/kubeconfig` and verify the cluster with `oc`.

DHCP, DNS, load balancing, the image registry, the HTTPS/iPXE server, and the
actual boot are all yours. That is the part UpOnLAN automates.

### Where UpOnLAN fits

UpOnLAN is a thin automation layer over steps 1–4 of that list: it keeps the two
declarative inputs as a saved **profile**, renders both YAML files, downloads and
verifies the pinned installer and `oc`, runs the installer on the server to
produce **immutable** ISO or PXE media, serves the PXE tree over HTTPS with a
local boot menu, and tracks versions.

| Classic step | Without UpOnLAN | With UpOnLAN |
|---|---|---|
| Get and verify tools | Download + checksum per release | Profile **Save** auto-downloads and verifies the pinned tools |
| Write the two YAML files | Hand-edit both | Form renders both; **Edit** reviews/saves them |
| Make media | Run the installer yourself | **Operations → Generate** runs it on the server |
| Serve PXE | Run your own HTTPS + boot script | Immutable `/okd/<profile>/<release>/vN/` served by the asset listener; publish a menu pointer |
| Boot nodes, wait, verify the cluster | You do all of it | **Still you** — UpOnLAN neither boots nor monitors machines |

It does **not** create DHCP, DNS, load balancing, or registries, does not boot
machines, and does not run the cluster. It stops at verified, immutable media
plus a copyable URL.

### Know which machine does what

| Component | Job |
|---|---|
| UpOnLAN server | Stores profiles, runs installer tools, serves media and PXE menus. It does not become a cluster node. |
| Target host/node | Boots Agent media and installs the node OS onto its selected disk. A host can be physical or a VM. |
| Control plane (master) | Runs the API, etcd, and cluster controllers. SNO/compact also run application workloads. |
| Worker | Runs workloads; standard clusters normally place ingress routers here. |
| Rendezvous host | One target control-plane node that coordinates Agent discovery and embedded bootstrap. |
| Image registry | Supplies release and workload container images. The HTTPS boot asset server is not a registry. |
| DHCP, DNS, NTP, gateway, load balancer | Infrastructure you provide, not services created by an UpOnLAN profile. |

### How Agent installation works

Both UpOnLAN and the manual procedure hand the same two inputs to the installer.
When you boot the declared nodes, they enter a live Agent environment: agents
contact the rendezvous host, validate the installation, fetch required images,
and install onto target disks. Bootstrap runs **inside this node workflow**; do
not add the separate temporary bootstrap machine of traditional UPI.

```text
OPERATOR / BROWSER                  UPONLAN SERVER (automatic after Save)
Profiles: mode/origin/trust -> Save > Store profile + regenerate both YAML files
                  |                Download + verify pinned installer and oc
                  v
Profiles:      Edit <-------------- Review YAML / previews / Tools status
                  |
Operations: Generate saved mode ---> Installer -> immutable release/vN media
Artifacts: review/download/publish <-------------------- results
                  |
OPERATOR / TARGET NODES             AGENT ON TARGET NODES (automatic)
Verify disks -> one-time boot ----> Live agents -> rendezvous -> validations
                                               -> disk writes -> cluster starts
Operator checks cluster <--------- Bootstrap complete -> installation complete
```

**Generate is preparation. Boot starts the potentially destructive installation.**
Selecting a generation format does not create a later safety pause on the nodes.
Booted Agent media can automatically overwrite selected disks after validations
pass. Never boot media just to see whether the inventory looks right.

### Choose a topology

| Choice | Nodes | Infrastructure consequence |
|---|---|---|
| First lab: `none` + SNO | 1 control plane, 0 workers | One node is rendezvous, API, and ingress. No separate load balancer; no high availability. |
| Compact | 3 control planes, 0 workers | Applications and ingress share control-plane capacity. |
| Standard | 3 control planes + workers | Separate workload capacity; form accepts 1–20 workers, but native release/platform constraints still apply. |

Use `none` when you supply endpoint routing/load balancing. The form also renders
`baremetal` variants with API/ingress VIP fields. Cluster-native VIP management is
conditional on the release, topology, and network supporting it; external DNS is
still yours. A rendered configuration is not proof of supported or working hardware.
Do not apply multi-node VIP requirements to the recommended `none` SNO lab.

Profiles and generation are pinned to **5.0.0-okd-scos.1**, Linux amd64. Other
legacy tool pins being accessible does not mean arbitrary releases are supported.
Multi-node, baremetal, and real boot/cluster acceptance remain to be verified on
your infrastructure.

### Official reading, without changing installation methods

- [OKD product architecture](https://docs.okd.io/latest/architecture/architecture.html)
  explains platform components.
- [Installing on any platform (`none`)](https://docs.okd.io/latest/installing/installing_platform_agnostic/installing-platform-agnostic.html)
  describes infrastructure, DNS, ports, and load balancing. Use those requirements,
  **not its separate-bootstrap UPI execution steps**, for this Agent workflow.
- [Preparing a single-node cluster](https://docs.okd.io/latest/installing/installing_sno/install-sno-preparing-to-install-sno.html)
  explains SNO trade-offs and current hardware guidance.
- [OKD networking](https://docs.okd.io/latest/networking/networking_overview/understanding-networking.html)
  explains cluster networking.
- [Disconnected installation mirroring](https://docs.okd.io/latest/disconnected/index.html)
  covers image availability without public registry access.
- [Upstream Agent installation source documentation (supplemental)](https://raw.githubusercontent.com/openshift/openshift-docs/main/installing/installing_with_agent_based_installer/installing-with-agent-based-installer.adoc)
  describes Agent inputs, boot, and completion. The published OKD Agent-specific
  pages were unavailable when checked; this is upstream source, not a verified
  exact-release OKD installation recipe.

The `latest` documents move. Check release-specific requirements before real use;
they do not change UpOnLAN's pinned version.

Next: [2. Infrastructure checklist](Kubernetes/OKD/02-Infrastructure-Checklist.md)
