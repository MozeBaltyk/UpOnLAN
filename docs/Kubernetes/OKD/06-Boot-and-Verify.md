## Boot and verify

**Boot is destructive:** Agent can overwrite selected disks automatically after
validation. There is no UpOnLAN Proceed button or guaranteed manual pause.
Target boot, completed installation, BIOS/UEFI disk handoff, and Secure Boot
remain unvalidated by the local generation/browser tests.

1. Check the selected artifact version and checksums. For PXE, confirm publication
   and architecture-appropriate DHCP/iPXE targets.
2. Independently verify physical MACs, roles, DHCP reservations, and disk WWN/serial
   against the profile. Use disposable disks for first acceptance.
3. Boot all declared hosts using firmware/BMC **one-time** PXE or virtual ISO.
   Do not add a separate UPI bootstrap machine. Remove media/set local disk next.
4. For PXE, verify HTTPS boot script/kernel/initrd retrieval, then the Agent live
   initramfs rootfs fetch from the same version. Both environments need trust in
   the origin's complete TLS chain. Browser success or iPXE-only embedded trust is
   insufficient; `additionalTrustBundle` is too late for early rootfs retrieval.
5. Observe Agent consoles and installation progress. Use **Operations → Start
   monitoring** for install-complete, or authorized server-side native checkpoints
   with the exact verified installer and original private workspace:

```text
openshift-install agent wait-for bootstrap-complete --dir <original-workspace>
openshift-install agent wait-for install-complete --dir <original-workspace>
```

Recover `<original-workspace>/auth/kubeconfig` through approved secure filesystem/
SSH access. There is no browser credential download. Protect destination permissions
and backups; verify nodes, core operators, and application routes independently.

The menu's local boot action exits to firmware after confirmation; it does not
detect disks or guarantee local boot. Firmware can choose PXE again. One-time boot
and removing media are the operator's responsibility. Never bypass TLS to get past
a failure.

The read-only `scripts/verify_okd_boot_readiness.py` readiness verifier
checks local publication, hashes, ROM evidence, and HTTPS structure. Passing local
checks is not physical boot or cluster acceptance; missing ROM evidence is a real
blocker, not permission to fabricate it.

Previous: [Generate and publish](Kubernetes/OKD/05-Generate-and-Publish.md) · Next:
[Storage and backup](Kubernetes/OKD/07-Storage-Security-and-Backup.md)
