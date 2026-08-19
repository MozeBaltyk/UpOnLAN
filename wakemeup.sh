#!/bin/bash
set -eu

OUTPUT_ROOT="release/output"

run_release_assets() {
    bash scripts/release_assets.sh "${asset_target:-}"
}

build() {
    sudo podman build -t localhost/uponlan:latest .
}

deploy() {
    if [ "${local_deploy:-0}" = "1" ]; then
        if [ ! -f "$OUTPUT_ROOT/assets/endpoints.yml" ]; then
            echo "[deploy --local] Missing $OUTPUT_ROOT/assets/endpoints.yml"
            echo "[deploy --local] Run './wakemeup.sh -a mirror-assets [target]' first"
            return 1
        fi
        if [ ! -f "$OUTPUT_ROOT/menu/0.0.2/menus.tar.gz" ]; then
            echo "[deploy --local] Missing $OUTPUT_ROOT/menu/0.0.2/menus.tar.gz"
            echo "[deploy --local] Build the menu artifact first with scripts/release_menu.sh 0.0.2"
            return 1
        fi
        echo "[deploy] deploying uponlan container with local menus+assets"
        build
        # Kill any stale local mirror server (e.g. left by a prior deploy) so
        # the fresh one below binds port 8899 and serves the current output.
        pkill -f "http.server 8899" 2>/dev/null || true
        python3 -m http.server 8899 --directory ./$OUTPUT_ROOT >/dev/null 2>&1 &
        sudo podman play kube ./manifests/uponlan-local.yaml
        return 0
    else
        echo "[deploy] deploying uponlan container with remote menus+assets"
        build
        sudo podman play kube ./manifests/uponlan.yaml
    fi
}

destroy() {
    sudo podman play kube --down ./manifests/uponlan.yaml
    # Tolerate a missing image: a prior destroy/redeploy may have already
    # removed it, and `set -e` would otherwise abort the whole action.
    sudo podman rmi localhost/uponlan:latest 2>/dev/null || true
}

redeploy() {
    destroy
    deploy
}

logs() {
    sudo podman pod ps; echo ""
    sudo podman ps -a; echo ""
    sudo podman logs -f $(sudo podman ps -q)
}

connect() {
    sudo podman exec -it $(sudo podman ps --filter ancestor=localhost/uponlan:latest --format "{{.ID}}") /bin/sh
}

mirror-assets() {
    run_release_assets
    echo "[mirror-assets] local asset output built at ./${OUTPUT_ROOT}"
    # `[ -n ... ] && echo` returns non-zero under `set -e` when asset_target is
    # empty, aborting the action — use an explicit if instead.
    if [ -n "${asset_target:-}" ]; then
        echo "[mirror-assets] target: ${asset_target}"
    fi
}

test-webapp() {
    read -p "Which test layer? [all/unit/integration/e2e/smoke] (default: all): " layer
    layer=${layer:-all}
    case $layer in
        all) cmd="node node_modules/vitest/vitest.mjs run" ;;
        unit|integration|e2e|smoke) cmd="node node_modules/vitest/vitest.mjs run test/${layer}" ;;
        *) echo "Invalid layer: $layer (use all/unit/integration/e2e/smoke)"; exit 1 ;;
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

exec_cmd() {
    eval "${action}"
}

print_help() {
    echo ""
    echo "Usage: ./wakemeup.sh -a <action> [--local]"
    echo ""
    echo "Allowed Actions"
    echo "---------------"
    echo "1. build - build uponlan image"
    echo "2. deploy [--local] - deploy uponlan container; --local serves local menus/assets from release/output"
    echo "3. destroy - destroy uponlan container"
    echo "4. redeploy [--local] - redeploy uponlan container; --local serves local menus/assets from release/output"
    echo "5. logs - display logs from uponlan container"
    echo "6. connect - connect to uponlan container"
    echo "7. mirror-assets - build local asset output; set asset_target=<os> to build one set, e.g. asset_target=harvester ./wakemeup.sh -a mirror-assets"
    echo "8. test-webapp - run webapp tests inside the container"
    echo ""
}

action=""
local_deploy=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        -a)
            action="$2"
            shift 2
            ;;
        --local)
            local_deploy=1
            shift
            ;;
        *)
            print_help
            exit 1
            ;;
    esac
done

if [[ -z "${action}" ]]; then
    print_help
    exit 1
fi

case $action in
    build) echo "Action: build uponlan image" ;;
    deploy) [ "$local_deploy" = "1" ] && echo "Action: deploy with local release/output" || echo "Action: deploy uponlan container" ;;
    destroy) echo "Action: destroy uponlan container" ;;
    redeploy) echo "Action: redeploy uponlan container" ;;
    logs) echo "Action: display logs from uponlan container" ;;
    connect) echo "Action: connect to uponlan container" ;;
    mirror-assets) echo "Action: build local asset output" ;;
    test-webapp) echo "Action: run webapp tests in container" ;;
    *) echo "Invalid action: $action"; print_help; exit 1 ;;
esac

exec_cmd
