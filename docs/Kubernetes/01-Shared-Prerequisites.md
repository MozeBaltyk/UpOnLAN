## Infrastructure checklist

Before creating a cluster profile:

- Inventory architecture, RAM/CPU, disks, MACs, interfaces, and machine roles;
  check capacity against the selected release's official requirements.
- Arrange stable DHCP reservations, DNS, routing, NTP, and required firewall paths.
- Choose BIOS or UEFI and the matching DHCP boot target if using PXE.
- Ensure every target can reach approved registries and the HTTPS artifact origin.
- Restrict administration and artifact downloads to approved provisioning clients.
- Back up data and plan one-time media boot followed by local-disk boot.

UpOnLAN serves boot media and menus; it does not configure DHCP, DNS, switches,
BMCs, or cluster load balancers.

See [PXE basics](02-PXE-Basics.md), [DHCP](Networks/02-DHCP.md), and
[Assets](03-Assets.md). Continue with [OKD prerequisites](Kubernetes/OKD/01-Prerequisites.md).
