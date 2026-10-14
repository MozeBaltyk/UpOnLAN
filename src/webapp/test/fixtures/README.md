# Agent source-template fixture

`agent-native-source.ipxe` substitutes a dummy origin, x86_64 and illustrative
kernel arguments into the official `createiPXEScript` format checked on 2026-10-14:

https://raw.githubusercontent.com/openshift/installer/060487ab202f49963ac21f2d9827265fc119d7e3/pkg/asset/agent/image/agentpxefiles.go

This immutable upstream source has named initrd, `initrd=initrd`, `vmlinuz`,
conditional script creation and the boot-artifacts directory contract. It is
**not** a captured installer run or a commit mapped to pinned OKD 5.0.0-okd-scos.1.
Public release.txt and GitHub release metadata/checksums do not provide that
installer-source mapping; native/pinned acceptance remains required.
