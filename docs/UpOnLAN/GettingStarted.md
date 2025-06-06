## Getting Started

As prerequisites:

* A `podman engine` installed.

* A KVM install with `virt-manager`, Not mandatory but good to have for testing purpose. 

```bash
Usage: ./wakemeup.sh -a <action>

Allowed Actions
---------------
1. build - build uponlan image
2. deploy - deploy uponlan container
3. destroy - destroy uponlan container
4. redeploy - redeploy uponlan container
5. logs - display logs from uponlan container
6. connect - connect to uponlan container
7. test - pxeboot a VM on kvm domain
8. network - check kvm/podman networks info
```

---