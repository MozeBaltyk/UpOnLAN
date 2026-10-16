## Kubernetes: install OKD with UpOnLAN

Want to build a cluster? Start with **one disposable Linux amd64 machine,
DHCP, platform `none`, Single Node OpenShift (SNO), and ISO boot**. Learn that
path before adding load balancers, more nodes, or PXE trust requirements.

Follow these four steps in order:

1. [Understand the installation](Kubernetes/OKD/01-Understand-the-Installation.md)
   — what OKD is, where the installer runs, and what happens on the nodes.
2. [Prepare infrastructure](Kubernetes/OKD/02-Infrastructure-Checklist.md)
   — fill in an inventory and check hardware, DHCP, DNS, routing, and trust.
3. [Generate media with UpOnLAN](Kubernetes/OKD/03-Generate-with-UpOnLAN.md)
   — Save, Edit, automatic tools, then ISO or PXE artifacts.
4. [Boot and verify](Kubernetes/OKD/04-Boot-and-Verify.md)
   — recheck disks, boot once, watch installation, and check the cluster.

Keep [Reference and troubleshooting](Kubernetes/OKD/05-Reference-and-Troubleshooting.md)
for recovery, storage locations, credentials, and common failures.

**Scope:** UpOnLAN generates Agent media for the pinned release
**5.0.0-okd-scos.1**. It is not a general-purpose vanilla Kubernetes installer.
It does not create your underlying infrastructure or boot machines for you.

**Safety:** generating media does not install OKD on the UpOnLAN server.
Booting that media on a target can **automatically overwrite its selected disk**.
There is no guaranteed approval pause after boot.

Native ISO/PXE generation with synthetic DHCP lab inputs and browser workflows
has been tested. Real target boot, complete cluster installation, and Secure Boot
have **not** been validated. A successful generation job is not a working cluster.
