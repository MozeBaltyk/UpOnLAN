## OKD prerequisites

Use Linux amd64 hosts and the pinned **5.0.0-okd-scos.1** Agent installer.
Start with disposable disks and platform `none` SNO for initial lab acceptance.
Supported forms also include compact and standard topologies, and platform
`baremetal`; form validation is not proof of working infrastructure.

- Provide DHCP reservations and verified host MAC, IP, role, interface, and
  rendezvous IP. Form IPs describe inventory; they do not configure static IPs.
  The current runtime lacks `nmstatectl`: **static NMState generation is unsupported**.
- Provide `api.<cluster>.<domain>`, `api-int.<cluster>.<domain>`,
  `*.apps.<cluster>.<domain>`, and host forward/reverse DNS, plus stable gateway,
  DNS/NTP and registry access. Allow rendezvous TCP 8090 between cluster hosts.
- For `none` SNO, API/api-int/apps DNS points to the single node; no separate LB
  is needed. Multi-node `none` needs L4 API 6443 and internal MCS 22623 to masters,
  and ingress 80/443 to router nodes (masters for compact). For `baremetal`,
  verify release-specific VIP requirements; VIP fields do not configure DNS.
- Configure a restricted HTTPS artifact origin reachable by the targets. For PXE,
  both the actual iPXE binary **and** Agent live initramfs must trust its full TLS
  chain. Trust embedded only in iPXE does not cover the later rootfs fetch.
- Choose an explicit root-device hint: WWN, serial, by-path, or a conventional
  whole-device name. Prefer stable identity over names such as `/dev/sda` that
  can move. UpOnLAN never chooses a disk for you.

**Agent boot can automatically overwrite selected disks once validations pass.**
There is no guaranteed discovery-only pause. Verify physical inventory and backups
before boot; keep Secure Boot off for first lab acceptance unless an independently
signed/enrolled path has been established. Secure Boot is not validated here.

The provisioning server is not automatically the cluster's load balancer or DHCP
server. Follow the [official OKD Agent installation guide](https://docs.okd.io/latest/installing/installing_with_agent_based_installer/).

Next: [Quick start and scope](Kubernetes/OKD/02-Architecture-and-Scope.md)
