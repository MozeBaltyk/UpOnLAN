## Quick start and scope

First complete the [prerequisites](Kubernetes/OKD/01-Prerequisites.md). You need
DHCP/DNS and topology-appropriate load balancing, verified target disks, registry
access, persistent UpOnLAN storage, and a trusted HTTPS artifact origin.

1. [Configure UpOnLAN](Kubernetes/OKD/03-Configure-UpOnLAN.md) with the public URL
   and persistent storage. Public OKD registries can use the built-in dummy pull
   secret; configure a custom secret only when registry authentication is needed.
2. Open **OKD → Profiles**, choose **New**, enter cluster and host details, then
   **Save**. Save persists the profile and starts exact-release tools preparation
   on the server without waiting for downloads.
3. Open **Edit** to review the two YAML tabs, shared **Pull Secret**, and read-only
   **Tools** status. Wait for verified installer and client readiness; resolve the
   reasons displayed beside **Generate**. Save retries tool failures.
4. Choose **Generate → ISO** for first disposable acceptance, or **PXE boot**.
   Confirm the disk warning and follow the job in **Operations**.
5. Open **Artifacts**. Download a successful ISO, or **Publish** a successful PXE
   version to the local OKD menu. Generation alone does not publish.
6. Independently recheck disks and networking, then perform a firmware/BMC one-time
   media boot. Remove media/set local disk for the next boot.
7. Optionally use **Operations** monitoring, health, and probes. Verify the actual
   installation and securely recover kubeconfig from the private workspace.

Tools run on the server; they are not browser downloads. Profiles and generation
support only **5.0.0-okd-scos.1**, even though the tools service can verify other
releases. UpOnLAN does not manage cluster lifecycle or roll back installed machines.

Real pinned-installer ISO and PXE output with synthetic DHCP lab configuration,
artifact finalization, and browser workflows have been tested. No target boot,
complete cluster installation, or Secure Boot acceptance is claimed.

Previous: [Prerequisites](Kubernetes/OKD/01-Prerequisites.md) · Next:
[Configure UpOnLAN](Kubernetes/OKD/03-Configure-UpOnLAN.md)
