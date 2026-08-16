## Getting Started

### Prerequisites

- Podman, with permission to run the `sudo podman` commands used below.
- Available host ports `3000/TCP` (webapp), `8080/TCP` (boot HTTP), and `69/UDP` (TFTP). A KVM/virt-manager VM is optional for PXE testing.
- DHCP already configured by your network administrator to give PXE clients an address and the correct boot file. UpOnLAN does **not** configure DHCP; do not invent or run DHCP commands from this guide.

### First run

From the repository root, build and deploy the default remote-menu setup:

```bash
./wakemeup.sh -a build
./wakemeup.sh -a deploy
```

The build creates `localhost/uponlan:latest`. Deployment reports that it is deploying remote menus and assets and starts the Podman pod.

Open `http://<server>:3000` from an administrator network. In the webapp, open the menu browser, select an available release, and choose the upgrade action. The menu version and files refresh after the upgrade completes. This is the recommended first menu workflow; it uses the configured remote endpoint rather than local release artifacts.

Verify the running service and inspect failures with:

```bash
sudo podman pod ps
./wakemeup.sh -a logs
```

Expect an UpOnLAN pod/container in the first command and container logs in the second. For a PXE client, a successful boot reaches TFTP for iPXE and then retrieves its menu/assets over HTTP; use a test VM only after DHCP points it at the appropriate boot file.

### Safe next steps

- Read [PXE Basics](02-PXE%20Basics.md) before changing network-boot settings.
- Read [Deployment](UpOnLAN/Deployment.md) for ports, authentication, remote versus local deployment, and release artifacts.
- Read [Operations](UpOnLAN/Operations.md) for logs, backup, recovery, and destructive operations.
