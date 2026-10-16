## 4. Boot and verify

**Boot can automatically erase selected target disks after Agent validations
pass. There is no guaranteed discovery-only pause or later UpOnLAN Proceed button.**
Start with the single disposable SNO target. Generation success is not permission
to skip the checks below.

### Before Boot: independent final check

- [ ] Match each physical/VM MAC, role, reserved DHCP address, and live NIC name
  to the selected profile revision. Check the rendezvous is a control-plane node.
- [ ] Recheck actual disk serial/WWN against every host's root-device hint.
  Back up required data and disconnect disks that must not be touched where practical.
- [ ] Check artifact version and hashes; do not mix files from different versions.
  PXE must offer the intended published version; ISO must be the intended download.
- [ ] Test DNS, gateway/route, NTP, registry connectivity, and required peer traffic
  from the target network, not just the UpOnLAN server. Check DNS/LB/VIPs for the
  chosen topology using the [checklist](Kubernetes/OKD/02-Infrastructure-Checklist.md).
- [ ] Confirm trusted HTTPS access and network restrictions. For PXE, validate
  iPXE trust and review the pinned native rootfs integrity/TLS limitation below.
  Do not add TLS bypasses to resolve an iPXE certificate error.
- [ ] Have console access, an agreed maintenance window, and a one-time media boot
  followed by local-disk boot. Validate your firmware/Secure Boot policy separately.

### ISO and PXE take different paths to the same Agent

```text
ISO (first lab)
Operator: download ISO -> attach virtual media / approved USB -> one-time boot
Target:   firmware -> full ISO [kernel + initrd + rootfs] -> live Agent

PXE
Operator: publish version -> configure DHCP boot target -> one-time network boot
Target:   firmware -> DHCP / boot binary -> iPXE
                                           |
          HTTPS script + kernel + initrd <--+  [trust store A: iPXE]
                      |
                      v
          Agent live initramfs -> rootfs [HTTPS trust unsupported/unverified here]
                      |
                      v
                 live Agent -> rendezvous -> validation -> target disk install

Both: fetch required registry images -> bootstrap -> cluster completion
      reboot from LOCAL DISK (operator must arrange firmware/media handoff)
```

The full ISO includes rootfs, so it avoids the PXE early HTTPS rootfs fetch;
it is **not** an offline cluster install without required images/mirrors.
For PXE, the CA embedded in iPXE is **not automatically copied** to the live
initramfs. This repository contains no reproducible extraction/result proving how
the exact generated Agent initramfs authenticates that HTTPS request, and no supported
native early-CA switch is established here. UpOnLAN adds no bypass and no custom
initrd writer. `additionalTrustBundle` configures later deployment/registry trust,
not this download. Self-signed PXE is therefore unsupported/unverified until the
exact generated initramfs and a live boot are validated independently. Browser
download success does not prove either boot path.

### 1. Boot the declared nodes once

Use firmware/BMC one-time ISO or PXE boot on all declared nodes. For SNO that is
one node; for compact/standard, include the rendezvous and every declared peer.
Do not create a separate UPI bootstrap VM.

Watch node consoles for live networking, rendezvous discovery/validation, image
pulls, disk installation, and reboot. Remove virtual media or restore local-disk
boot for the next boot so nodes do not re-enter the installer. The menu's local
boot action only exits to firmware after confirmation; firmware may choose PXE
again. It does not discover the installed disk for you.

### 2. Observe installation, not just generation

The OKD **Operations** tab does not monitor installation or run health/probe
diagnostics. It only generates media and shows generation state, history, and
bounded generation logs. Observe target consoles and use authorized native tools
from a secure administration environment.

For authorized server-side checks, use the exact verified installer shown in
**Edit → Tools** and the **original** generation workspace:

```text
<verified-installer-path> agent wait-for bootstrap-complete --dir <original-workspace>
<verified-installer-path> agent wait-for install-complete --dir <original-workspace>
```

`bootstrap-complete` is an intermediate checkpoint, not cluster completion.
Keep original installer state; a new empty directory or a regenerated profile
cannot replace it. Cancelling a generation job does **not** stop installation on
already booted nodes or restore disks.

### 3. Verify the resulting cluster

Recover `<original-workspace>/auth/kubeconfig` through approved secure filesystem/
SSH access with restrictive destination permissions. There is no browser credential
download. Never paste kubeconfig, passwords, or private workspace contents into
tickets. Use the verified `oc` with that kubeconfig on an authorized admin host:

```sh
oc --kubeconfig <secure-kubeconfig-path> get nodes -o wide
oc --kubeconfig <secure-kubeconfig-path> get clusteroperators
oc --kubeconfig <secure-kubeconfig-path> get clusterversion
```

Before calling installation complete, confirm:

- [ ] Native `install-complete` succeeds for the original workspace.
- [ ] Expected nodes are present, have correct roles/IPs, and are **Ready**.
- [ ] Core Operators are **Available**, not persistently **Progressing** or
  **Degraded**; cluster version agrees with the intended release.
- [ ] API, console login, and a test application route work from intended clients.
- [ ] Reboots use local disks; DNS, time, storage, and required registry access
  remain correct. Plan workload storage, identity/RBAC, updates, and backups before
  putting real applications on the cluster.

**Acceptance boundary:** local synthetic ISO/PXE generation and browser tests did
not boot a target or complete a cluster. Your hardware, firmware handoff, Agent
TLS trust, registry reachability, and Secure Boot still need real acceptance.
If installation fails, preserve state/logs and diagnose before retrying boot;
regenerating or unpublishing media is not a rollback of an installed machine.

Previous: [3. Generate](Kubernetes/OKD/03-Generate-with-UpOnLAN.md) ·
Help: [Reference and troubleshooting](Kubernetes/OKD/05-Reference-and-Troubleshooting.md)
