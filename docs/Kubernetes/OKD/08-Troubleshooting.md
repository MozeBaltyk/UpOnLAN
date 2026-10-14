## Troubleshooting

| Problem | Action |
|---|---|
| Generate disabled | Follow the displayed blockers: save/reload, verified installer **and oc**, persistent storage, HTTPS origin, valid resolved secret, or another active job. |
| Tools failed | Check server egress, disk space, and permissions in Edit → Tools. Save retries exact-release preparation; preserve YAML edits before form Save. Do not substitute `latest` or a PATH binary. |
| Generation failed | Review the bounded log, registry access, native schema requirements, and workspace capacity. Static NMState is unsupported: use DHCP. |
| Pull Secret Add/update disabled | Internal mutation needs both web credentials and persistent config. External storage is authoritative/read-only; fix or rotate its mount and restart. Invalid existing storage never falls back. |
| External secret unreadable | Check regular-file/no-symlink constraints and UID/GID 911 read access. Kubernetes subPath rotation needs restart; do not make it world-readable. |
| Version absent from menu | Publish a finalized PXE version explicitly. ISO is download-only; generation does not activate media. |
| Rootfs fails after iPXE works | Verify TLS chain and trust in the Agent live initramfs, not just iPXE/browser. Never bypass TLS. |
| Monitoring/health unavailable | Select a successful matching-revision version; check verified tools and the original workspace's regular auth/kubeconfig. Monitoring is opt-in and query success is not health. |
| Probes fail | Check DNS/LB/firewalls from both server and target networks. Server DNS/TCP probes do not validate target TLS/DHCP or installation. |
| Profile deletion/cleanup blocked | Remove eligible artifact versions first; retain protected installation state and secure backups. Unpublish is neither retirement nor access revocation. |

After restart, unfinished jobs are `interrupted`, never automatically resumed.
For partial profile writes, restore a verified consistent set as described in
[backup and recovery](Kubernetes/OKD/07-Storage-Security-and-Backup.md).
Do not include secrets, kubeconfig, or private workspace contents in tickets.
See [service operations](UpOnLAN.xyz/03-Operations.md) for general checks.

Previous: [Storage and backup](Kubernetes/OKD/07-Storage-Security-and-Backup.md) ·
Start: [Prerequisites](Kubernetes/OKD/01-Prerequisites.md)
