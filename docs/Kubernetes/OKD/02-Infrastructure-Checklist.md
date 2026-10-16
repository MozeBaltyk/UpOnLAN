## 2. Infrastructure checklist

**Finish this before opening the profile editor.** UpOnLAN will not create these
services, reserve addresses, or check your physical disks for you.

### Write down your first-lab plan

This example uses cluster name `lab`, base domain `example.com`, and thus cluster
domain **`lab.example.com`**. Addresses in `192.0.2.0/24` and `example.com` are
documentation placeholders: replace them with your own routed lab network/domain.
Do not use them unchanged as real infrastructure.

| Item | Example / value to record |
|---|---|
| Profile ID; release | `lab-sno`; `5.0.0-okd-scos.1` |
| Platform; topology; workers | `none`; `sno`; `0` |
| Machine network; gateway | `192.0.2.0/24`; `192.0.2.1` |
| DNS resolver; NTP | `192.0.2.53`; `192.0.2.123` |
| Target hostname; role | `master-0`; control plane |
| Reserved IPv4; rendezvous IPv4 | `192.0.2.10`; `192.0.2.10` |
| MAC; live-environment NIC name | `<VERIFIED_NODE_MAC>`; `<VERIFIED_INTERFACE>` |
| Disk hint type; value | Serial; `<VERIFIED_DISK_SERIAL>` |
| SSH public key | `<YOUR_SSH_PUBLIC_KEY>` (your actual public key, never private key) |
| UpOnLAN HTTPS asset origin (PXE only) | `https://pxe.example.com:8443/` |
| Registry access | Public internet, or a prepared private mirror |

The boot mode and Asset server URL belong to each **profile**. New profiles default
to PXE and `https://192.168.7.1:8443/`; replace that URL unless every target can
reach it and its certificate covers that IP. Before generating PXE, enter the final
production HTTPS root in **Profiles → Installation media**. It may be UpOnLAN's
asset listener or a separate server where you will extract the exported bundle.
Use only a credential-free HTTPS root with no query, fragment, or extra path.
Private IPs/ULA are allowed, but localhost, loopback, mapped, unspecified,
multicast, and link-local addresses are not.

UpOnLAN performs a bounded TLS handshake inspection on the endpoint. A valid
system-trusted certificate is reported directly. An untrusted or self-signed
certificate is never trusted silently: inspect its subject, SAN, validity, chain,
and SHA-256 fingerprint, then explicitly confirm its public CA material. A later
presented-versus-stored mismatch blocks PXE Save/Generate until resolved. Inspection
does not provision DNS, make the endpoint reachable from targets, or prove either
iPXE or the Agent early rootfs download accepts the chain. Existing finalized media
keeps its original URL; changing the profile does not rewrite it.

ISO does not require or use an Asset server URL. For a local cluster domain you
may plan `lab.home.arpa` instead of the documentation domain; configure that DNS
yourself.

The node IPv4 in the form is **inventory for your DHCP reservation**, not a static
network configuration. Gateway, prefix, DNS, NTP, and routes must still be supplied
and verified outside the form, even with DHCP.

### Before Generate: hardware and recovery

- [ ] Inventory every node's CPU architecture/features, CPU count, RAM, disks,
  NIC MACs, and firmware mode. This workflow uses Linux amd64 tools/media.
- [ ] Size nodes against the official [SNO guidance](https://docs.okd.io/latest/installing/installing_sno/install-sno-preparing-to-install-sno.html)
  or [multi-node requirements](https://docs.okd.io/latest/installing/installing_platform_agnostic/installing-platform-agnostic.html).
  Current SNO documentation lists 4 vCPUs, 16 GB RAM, and 120 GB storage, and warns
  that 4 vCPUs leaves little application headroom. For a disposable SNO lab, plan
  **at least 8 vCPUs, 32 GiB RAM, and 120 GB fast SSD**, plus workload capacity.
  This is a conservative planning baseline, **not an independently verified
  minimum for 5.0.0-okd-scos.1**. Validate the exact release before boot.
- [ ] For VMs, enable hardware virtualization in the hypervisor, expose a compatible
  CPU, and reserve sufficient CPU/RAM and fast storage; avoid resource contention.
  Nested virtualization is needed only if the intended workload itself needs it.
- [ ] Record the actual installation disk serial/WWN on each target. Check capacity,
  SSD latency/endurance, backups, and which other attached disks must be preserved.
  Do not assume the OS disk is `/dev/sda` or that device names stay constant.
- [ ] Have console/BMC access and a one-time ISO/PXE boot method. Record BIOS/UEFI
  choice and local-disk boot order. Secure Boot is unvalidated here: a disposable
  lab may deliberately test with it off, but do not disable a required security
  control on real machines; establish a validated signed/enrolled path instead.

### Before Generate: network, addressing, and time

- [ ] Create stable DHCP reservations for **all** target MACs. Record the correct
  live Agent NIC names; VM NIC models or firmware changes can change those names.
- [ ] Verify subnet prefix, gateway, DNS resolver, NTP addresses, default route,
  VLAN, MTU, and return paths from the target network. Synchronize clocks on nodes
  and server; bad time breaks certificates and cluster operation.
- [ ] Keep machine, pod, service, and infrastructure networks from overlapping.
  Also avoid the live installer's container bridge subnet (commonly `10.88.0.0/16`).
  Verify node-to-node routing; NAT that breaks peer reachability is not a solution.
- [ ] Allow required cluster traffic only between appropriate sources/destinations.
  This includes live peers reaching rendezvous TCP **8090**, API **6443**, internal
  machine configuration **22623**, DNS/NTP, registry HTTPS, and the release's etcd,
  kubelet, and overlay traffic. Those example ports are **not a complete allowlist**.
  Use the network/port tables in the official [infrastructure guide](https://docs.okd.io/latest/installing/installing_platform_agnostic/installing-platform-agnostic.html)
  and [networking overview](https://docs.okd.io/latest/networking/networking_overview/understanding-networking.html).
  For rendezvous discovery specifically, see [upstream Agent networking source
  (supplemental)](https://raw.githubusercontent.com/openshift/openshift-docs/main/modules/agent-install-networking.adoc).
  Do not open the entire firewall or expose etcd/MCS to the internet.
- [ ] If using PXE, configure the firmware-appropriate DHCP boot target and verify
  the iPXE chain. See [PXE basics](02-PXE-Basics.md) and [DHCP](Networks/02-DHCP.md).

**Use DHCP for this workflow.** The current Alpine runtime lacks `nmstatectl`, so
static NMState generation is unsupported. Expert supplemental `networkConfig`
YAML can be saved, but saving it does not provide the missing generation helper
or establish a supported static-network installation path.

### Before Generate: DNS and endpoint routing

Create DNS on a resolver the nodes **and your admin clients** can use. Check
forward lookups and node reverse (PTR) records. The table keeps SNO and multi-node
examples separate; choose one column, not a mixture.

| DNS name | First lab: `none` SNO | Multi-node `none` example |
|---|---|---|
| `api.lab.example.com` | `192.0.2.10` | API LB address `192.0.2.20` |
| `api-int.lab.example.com` | `192.0.2.10` | Internal API/MCS LB `192.0.2.20` |
| `*.apps.lab.example.com` | `192.0.2.10` | Ingress LB address `192.0.2.21` |
| `master-0.lab.example.com` | `192.0.2.10` + matching PTR | `192.0.2.10` + matching PTR |
| `master-1.lab.example.com` | Not present | `192.0.2.11` + matching PTR |
| `master-2.lab.example.com` | Not present | `192.0.2.12` + matching PTR |
| `worker-0.lab.example.com` | Not present | `192.0.2.30` + matching PTR |
| `worker-1.lab.example.com` | Not present | `192.0.2.31` + matching PTR |
| `pxe.example.com` | UpOnLAN asset server, e.g. `192.0.2.5` | Same purpose, not a cluster endpoint |

- [ ] For **`none` SNO**, API, internal API, and apps go directly to the single
  node. Do not add an unnecessary external LB or multi-node VIPs.
- [ ] For **multi-node `none`**, provide L4 forwarding: API TCP 6443 and internal
  MCS TCP 22623 to control planes; ingress TCP 80/443 to nodes running routers
  (control planes in compact, normally workers in standard). Configure health
  checks and endpoint visibility per the official infrastructure requirements.
- [ ] For **`baremetal`**, confirm native VIP management is supported by the exact
  release/topology/network, reserve unused API/ingress VIPs, and point external DNS
  to them. UpOnLAN VIP fields do not configure DNS or build a load balancer.
- [ ] Resolve every declared node, API/api-int, and a test name under `apps` from
  the intended networks. Do not copy obsolete mandatory etcd SRV-record recipes
  without checking the selected release.

```text
                         YOU PROVIDE
 Admin clients ---- DNS / DHCP / NTP / gateway ---- Target network
       |                                               |
       +-- api:6443 ------ API endpoint ---- control planes (.10/.11/.12)
       +-- *.apps:80/443 - Ingress endpoint - routers (workers or compact masters)
                                                       |
 UpOnLAN (.5) -- ISO / HTTPS PXE media ---> all declared nodes
 Registries -------- release images -----> server + nodes

 SNO: both endpoints and rendezvous are the single node (.10); no LB.
 Multi-node none: endpoints are your L4 load balancers (.20/.21).
 Rendezvous is a control-plane node, NOT the UpOnLAN server or an extra VM.
```

### Before Generate: registries and UpOnLAN

- [ ] Public lab: allow server and nodes to reach the selected release's public
  registries. Tool preparation also needs **separate GitHub/download egress**.
  Successful tool downloads do not prove registry or target connectivity.
- [ ] Private/disconnected: prepare a mirror containing the required images,
  credentials, CA trust, DNS, and routing **before** generation. Plan supplemental
  mirror/trust settings using the [official mirroring guide](https://docs.okd.io/latest/disconnected/index.html).
  UpOnLAN does not create or populate a mirror for you.
- [ ] Persist UpOnLAN `/config`, `/assets`, `/menu`, and `/logs`, with sufficient
  free space for tools, images, versions, and private workspaces.
- [ ] For PXE, configure a reachable HTTPS asset origin with correct certificate SAN,
  complete chain, and valid clock. The usual asset port is **8443**, not the
  webapp portal's **3443**. See [Deployment](UpOnLAN.xyz/02-Deployment.md).
- [ ] Add required registry/proxy CA certificates in the profile's **Additional
  trust certificates** control. This per-profile PEM applies to both ISO and PXE
  generation and appears as `additionalTrustBundle` in `install-config.yaml`.
- [ ] Restrict asset URLs to approved provisioning clients using network/firewall/
  ingress policy. Media may contain credentials even when unpublished. Optional
  webapp login does **not** protect this separate listener.
- [ ] For PXE, validate **iPXE trust and the separate Agent rootfs HTTPS path**.
  This repository does not prove a supported early-rootfs custom-CA mechanism or a
  successful live self-signed boot. `additionalTrustBundle` is later deployment/
  registry trust, not proof of early-rootfs TLS trust. Treat self-signed PXE as
  unsupported/unverified until the exact generated initramfs is tested independently.

**Ready output:** a completed inventory, working DNS/DHCP and endpoint plan,
verified disk identities, registry plan, persistent storage, and trusted/restricted
asset origin when using PXE. Only then create the profile.

Previous: [1. Understand](Kubernetes/OKD/01-Understand-the-Installation.md) ·
Next: [3. Generate with UpOnLAN](Kubernetes/OKD/03-Generate-with-UpOnLAN.md)
