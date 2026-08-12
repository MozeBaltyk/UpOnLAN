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

# mirror-assets: build the local asset mirror under release/mirror.
# test-assets: deploy from the local asset mirror under release/mirror.
# Usage: ./wakemeup.sh -a <action>
mirror-assets () {
    bash scripts/release_assets.sh "${asset_target:-}"
    echo "[mirror-assets] local asset mirror built at ./release/mirror"
    [ -n "${asset_target:-}" ] && echo "[mirror-assets] target: ${asset_target}"
}

test-assets () {
    local version="$(grep -Eo 'set menu_version .*' ./release/menus/version.ipxe | awk '{print $3}')"
    local port=${LOCAL_PORT:-8899}

    bash scripts/release_menu.sh "$version"

    if [ ! -f release/githubout/menus.tar.gz ]; then
        echo "[test-assets] Missing release/githubout/menus.tar.gz"
        git checkout -- release/menus/version.ipxe
        return 1
    fi
    if [ ! -d release/mirror/releases/download ]; then
        echo "[test-assets] Missing release/mirror"
        echo "[test-assets] Run './wakemeup.sh -a mirror-assets [target]' first"
        git checkout -- release/menus/version.ipxe
        return 1
    fi

    while ss -tln | grep -q ":$port "; do
        port=$((port + 1))
    done

    mkdir -p "release/mirror/releases/download/${version}"
    cp "release/githubout/menus.tar.gz" "release/mirror/releases/download/${version}/menus.tar.gz"

    python3 -m http.server "$port" --directory ./release/mirror >/dev/null 2>&1 &
    local server_pid=$!

    local tmp; tmp=$(mktemp)
    sed -e "s|https://github.com/mozebaltyk/uponlan|http://host.containers.internal:${port}|" \
        -e "s|value: \"0.0.2\"|value: \"$version\"|" \
        ./manifests/uponlan.yaml > "$tmp"

    build
    sudo podman play kube --down ./manifests/uponlan.yaml 2>/dev/null || true
    sudo podman play kube "$tmp"
    rm -f "$tmp"

    echo -e "\n[test-assets] container is fetching menus+assets from http://host.containers.internal:${port} version ${version}"
    echo "[test-assets] mirror is LIVE on port ${port} (release/mirror) - keep it running while you test the webapp"
    echo "[test-assets] stop it with: kill ${server_pid}"

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
    echo "7. mirror-assets - build local asset mirror"
    echo "8. network - check kvm/podman networks info"
    echo "9. build-runner - build Ansible container"
    echo "10. run-runner - run Ansible container"
    echo "11. test-webapp - run webapp tests inside the container"
    echo "12. test-assets - deploy from local githubout mirror (no pxe test)"
    echo "13. test-pxeboot - pxeboot a VM on kvm domain"
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
    mirror-assets) echo "Action: build local asset mirror";;
    network) echo "Action: check kvm/podman networks info";;
    build-runner) echo "Action: build Ansible container";;
    run-runner) echo "Action: run Ansible container";;
    test-pxeboot) echo "Action: test pxe boot with a kvm domain";;
    test-assets) echo "Action: deploy with local assets";;
    test-webapp) echo "Action: run webapp tests in container";;
    *) echo "Invalid action: $action"; print_help; exit 1;;
esac

exec_cmd
