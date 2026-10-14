## Kubernetes guides

UpOnLAN's **OKD** page creates profiles, prepares exact-release tools, generates
Agent ISO/PXE media, publishes PXE menu entries, and offers optional monitoring.
These guides cover the supported Linux amd64 release **5.0.0-okd-scos.1**.

Start with the [infrastructure checklist](Kubernetes/01-Shared-Prerequisites.md)
and [OKD prerequisites](Kubernetes/OKD/01-Prerequisites.md), then follow the
[quick start](Kubernetes/OKD/02-Architecture-and-Scope.md).

- [Configure UpOnLAN](Kubernetes/OKD/03-Configure-UpOnLAN.md)
- [Create and edit profiles](Kubernetes/OKD/04-Profiles.md)
- [Generate, publish, and observe](Kubernetes/OKD/05-Generate-and-Publish.md)
- [Boot and verify](Kubernetes/OKD/06-Boot-and-Verify.md)
- [Storage and backup](Kubernetes/OKD/07-Storage-Security-and-Backup.md)
- [Troubleshooting](Kubernetes/OKD/08-Troubleshooting.md)

Native ISO and PXE generation with synthetic lab inputs and browser workflows
have been tested. Target boot, cluster installation, and Secure Boot have **not**
been validated. Generation success is not installation success.
