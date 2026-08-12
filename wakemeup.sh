#!/bin/bash
set -eu

build-runner() {
    sudo podman build -t localhost/uponlan-ansible:latest -f ansible/Containerfile .
}

run-runner() {
    sudo podman run -dit --name uponlan-ansible --pod uponlan \
        -v "$(pwd)/ansible:/ansible" \
        -v uponlan-config:/config \
        -v uponlan-assets:/assets \
        localhost/uponlan-ansible:latest
    sudo podman exec -it uponlan-ansible /bin/sh
}

build () {
    sudo podman build -t localhost/uponlan:latest .
}

deploy () {
    build
    sudo podman play kube ./manifests/uponlan.yaml
}

destroy () { 
    sudo podman play kube --down ./manifests/uponlan.yaml 
    sudo podman rmi localhost/uponlan:latest
}

redeploy () {
    destroy
    deploy
}

logs () {
    sudo podman pod ps; echo ""
    sudo podman ps -a; echo ""
    sudo podman logs -f $(sudo podman ps -q)
}

connect () {
    sudo podman exec -it $(sudo podman ps --filter ancestor=localhost/uponlan:latest --format "{{.ID}}") /bin/sh
}

network () {
    sudo chmod +x ./scripts/display_networks_info.sh
    ./scripts/display_networks_info.sh
}

test () {
    read -p "Which pxe_config do you want to test? [uponlan]: " pxe_config
    local pxe=${pxe_config:-"uponlan"}   # local or uponlan or netboot or uefi.http
    test-network-and-vm "$pxe"
}

# Shared: create KVM network, boot a VM, verify PXE boot reaches the container.
test-network-and-vm () {
    local pxe=$1
    local network_name="uponlan"
    sudo chmod +x ./scripts/create_kvm_test_network.sh
    sudo ./scripts/create_kvm_test_network.sh ${network_name} ${pxe}
    sudo chmod +x ./scripts/create_kvm_test_vm.sh
    sudo ./scripts/create_kvm_test_vm.sh ${network_name} ${pxe}
    sudo chmod +x ./scripts/verify_kvm_boot.sh
    sudo ./scripts/verify_kvm_boot.sh ${network_name} testpxe ${pxe}
}

# test-assets: build the menu tarball + re-root release/githubout asset files into
# the /releases/download/<key>/ URL layout, serve it locally, deploy the container
# pointed at that mirror. Validates endpoints.yml end-to-end without publishing a
# GitHub release. Run 'test' separately afterwards for the PXE-boot verification.
# Usage: ./wakemeup.sh -a test-assets
test-assets () {
    local version="local-$(date +%s)"

    # pick a free port (default 8899 may be taken by an old mirror)
    local port=${LOCAL_PORT:-8899}
    while ss -tln | grep -q ":$port "; do
        port=$((port + 1))
    done

    # 1. build menu tarball (bundles release/assets/endpoints.yml)
    bash scripts/release_menu.sh "$version"

    # 2. mirror githubout into the release URL layout the webapp/init.sh expect:
    #    menus.tar.gz at /releases/download/<version>/, asset files at
    #    /releases/download/<os>-<ver>-<arch>/ (same KEY build.sh writes in endpoints.yml)
    local mirror; mirror=$(mktemp -d)
    mkdir -p "$mirror/releases/download/$version"
    cp release/githubout/menus.tar.gz "$mirror/releases/download/$version/"
    local dir rest arch os ver key
    shopt -s nullglob
    for dir in release/githubout/*/*/*/releases/*/; do
        rest="${dir#release/githubout/}"
        arch="${rest%%/*}"; rest="${rest#*/}"
        os="${rest%%/*}";   rest="${rest#*/}"
        ver="${rest%%/*}"
        key="${os}-${ver}-${arch}"
        mkdir -p "$mirror/releases/download/$key"
        cp "$dir"* "$mirror/releases/download/$key/"
    done
    shopt -u nullglob
    python3 -m http.server "$port" --directory "$mirror" >/dev/null 2>&1 &
    local server_pid=$!

    # 3. temp manifest: point the container at the local mirror (podman's
    #    host.containers.internal always resolves to the host, no IP guessing)
    local tmp; tmp=$(mktemp)
    sed -e "s|https://github.com/mozebaltyk/uponlan|http://host.containers.internal:${port}|" \
        -e "s|value: \"0.0.2\"|value: \"$version\"|" \
        ./manifests/uponlan.yaml > "$tmp"

    # 4. rebuild image (init.sh/endpoints changes live in the image) and deploy
    build
    sudo podman play kube --down ./manifests/uponlan.yaml 2>/dev/null || true
    sudo podman play kube "$tmp"
    rm -f "$tmp"

    echo -e "\n[test-assets] container is fetching menus+assets from http://host.containers.internal:${port} version ${version}"
    echo "[test-assets] mirror is LIVE on port ${port} (temp dir: ${mirror}) - keep it running while you test the webapp"
    echo "[test-assets] stop it with: kill ${server_pid}"
    echo "[test-assets] then run './wakemeup.sh -a test' for the PXE boot check"

    # 5. restore what release_menu.sh rewrote so the tree stays clean
    git checkout -- release/menus/version.ipxe
}

test-webapp () {
    read -p "Which test layer? [all/unit/integration/e2e/smoke] (default: all): " layer
    layer=${layer:-all}
    # npm is purged from the final image (build-only dep), so call vitest directly
    case $layer in
        all) cmd="node node_modules/vitest/vitest.mjs run";;
        unit|integration|e2e|smoke) cmd="node node_modules/vitest/vitest.mjs run test/${layer}";;
        *) echo "Invalid layer: $layer (use all/unit/integration/e2e/smoke)"; exit 1;;
    esac

    cid=$(sudo podman ps --filter ancestor=localhost/uponlan:latest --format "{{.ID}}" | head -n1)
    if [[ -z "$cid" ]]; then
        echo "No uponlan container running. Start it first: ./wakemeup.sh -a deploy"
        exit 1
    fi
    if ! sudo podman exec "$cid" test -d /webapp/test; then
        echo "Container image does not contain the tests. Rebuild it first: ./wakemeup.sh -a build"
        exit 1
    fi

    echo "Running '$cmd' inside container $cid"
    sudo podman exec -it "$cid" sh -c "cd /webapp && $cmd"
}

exec_cmd () {
    eval "${action}"
}

print_help () {
    echo ""
    echo "Usage: ./wakemeup.sh -a <action>"
    echo ""
    echo "Allowed Actions"
    echo "---------------"
    echo "1. build - build uponlan image"
    echo "2. deploy - deploy uponlan container"
    echo "3. destroy - destroy uponlan container"
    echo "4. redeploy - redeploy uponlan container"
    echo "5. logs - display logs from uponlan container"
    echo "6. connect - connect to uponlan container"
    echo "7. test - pxeboot a VM on kvm domain"
    echo "8. network - check kvm/podman networks info"
    echo "9. build-runner - build Ansible container"
    echo "10. run-runner - run Ansible container"
    echo "11. test-webapp - run webapp tests inside the container"
    echo "12. test-assets - deploy from local githubout mirror (no pxe test)"
    echo ""
}

if [[ $# -ne 2 ]]
then
    print_help
    exit 1
fi

while getopts a: flag
do
    case "${flag}" in
        a) action=${OPTARG};;
    esac
done

case $action in
    build) echo "Action: build uponlan image";;
    deploy) echo "Action: deploy uponlan container";;
    destroy) echo "Action: destroy uponlan container";;
    redeploy) echo "Action: redeploy uponlan container";;
    logs) echo "Action: display logs from uponlan container";;
    connect) echo "Action: connect to uponlan container";;
    test) echo "Action: test pxe boot with a kvm domain";;
    test-assets) echo "Action: deploy from local githubout mirror + test pxe boot";;
    network) echo "Action: check kvm/podman networks info";;
    build-runner) echo "Action: build Ansible container";;
    run-runner) echo "Action: run Ansible container";;
    test-webapp) echo "Action: run webapp tests in container";;
    *) echo "Invalid action: $action"; print_help; exit 1;;
esac

exec_cmd