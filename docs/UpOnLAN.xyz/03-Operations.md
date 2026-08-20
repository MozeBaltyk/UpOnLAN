## Operations, data, and recovery

### Logs and first checks

Use the Monitor tab for webapp, TFTP, and Nginx activity, or follow container output:

```bash
./wakemeup.sh -a logs
```

For a shell in the running image, use `./wakemeup.sh -a connect`. Check port conflicts with `ss -tulpn`; TFTP uses `69/UDP`, while the chart publishes `8080/TCP` and `3000/TCP`.

### Ephemeral storage and backups

The deployed pod mounts `/config`, `/assets`, `/menu`, and `/logs` from `emptyDir`. They are not named volumes: destroying the pod or replacing it can remove menus, mirrored assets, configuration, and logs.

Before `destroy`, `redeploy`, host maintenance, or any pod replacement, copy the data you need from the running container or preserve the source artifacts outside the pod. Keep `release/output` outside the deployment as the local-release input; it is not a backup of webapp edits or logs. Restore by redeploying and then restoring saved content to the appropriate paths.

### Destructive actions and recovery

`./wakemeup.sh -a destroy` tears down the chart-rendered pod (`podman play kube --down`) and removes the local image. It is destructive for the deployed pod's ephemeral data. `redeploy` calls `destroy` first, so back up before using it.

If the service fails after deployment, inspect logs, resolve port or configuration errors, run `./wakemeup.sh -a build`, then deploy again. For a local deployment, recreate the required release artifacts before `./wakemeup.sh -a deploy --local`.