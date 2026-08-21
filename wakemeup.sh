#!/bin/bash
set -eu

# Colourise output when running in a terminal (NO_COLOR=1 disables it).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET='\033[0m'; C_BOLD='\033[1m'
    C_RED='\033[31m'; C_YELLOW='\033[33m'; C_GREEN='\033[32m'; C_CYAN='\033[36m'
else
    C_RESET=''; C_BOLD=''; C_RED=''; C_YELLOW=''; C_GREEN=''; C_CYAN=''
fi

OUTPUT_ROOT="release/output"

# Deployment chart + knob defaults. The default deploy pulls the published
# ghcr image (public — no login needed); --build (or --local) builds the local
# image instead, and --local also switches the endpoint to the local mirror +
# pins the menu version. ghcr pulls use Always so a deploy/redeploy always
# fetches the latest published `latest` tag instead of reusing a stale cache.
CHART="charts/uponlan"
UPONLAN_IMAGE_REPO="ghcr.io/mozebaltyk/uponlan"
UPONLAN_IMAGE_TAG="latest"
UPONLAN_PULL_POLICY="Always"
ENDPOINT_URL="https://github.com/mozebaltyk/uponlan"
MENU_VERSION=""

resolve_deploy_knobs() {
    # --build / --local use the locally-built image; otherwise pull from ghcr.
    if [ "${build:-0}" = "1" ] || [ "${local_deploy:-0}" = "1" ]; then
        UPONLAN_IMAGE_REPO="localhost/uponlan"
        UPONLAN_PULL_POLICY="Never"
    fi
    if [ "${local_deploy:-0}" = "1" ]; then
        ENDPOINT_URL="http://host.containers.internal:8899"
        MENU_VERSION="$(sed -n 's/^set menu_version //p' release/menus/version.ipxe)"
    fi
}

# Print the resolved deployment context (what will be deployed).
show_context() {
    echo -e "${C_BOLD}${C_CYAN}== deployment context ==${C_RESET}"
    echo -e "  ${C_BOLD}image:${C_RESET}    ${UPONLAN_IMAGE_REPO}:${UPONLAN_IMAGE_TAG} (${UPONLAN_PULL_POLICY})"
    echo -e "  ${C_BOLD}endpoint:${C_RESET} ${ENDPOINT_URL}"
    echo -e "  ${C_BOLD}menu:${C_RESET}     ${MENU_VERSION:-latest}"
    echo -e "  ${C_BOLD}ports:${C_RESET}    8080/tcp 3000/tcp 69/udp"
    echo -e "  ${C_BOLD}libvirt:${C_RESET}  /var/run/libvirt/libvirt-sock"
    for v in asset_target IPXE_VERSION PXE_ROM_PATH; do
        [ -n "${!v:-}" ] && echo -e "  ${C_BOLD}env ${v}${C_RESET}=${!v}"
    done
    echo ""
}

# Return 0 if the host port is already bound (TCP or UDP).
port_in_use() {
    local port="$1" proto="$2"
    case "$proto" in
        tcp) ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[.:]${port}$" && return 0 ;;
        udp) ss -lun 2>/dev/null | awk '{print $4}' | grep -qE "[.:]${port}$" && return 0 ;;
    esac
    return 1
}

# Preflight checks. Hard failures return non-zero; soft issues warn only.
preflight() {
    local fail=0
    command -v podman >/dev/null || { echo -e "${C_RED}ERROR: 'podman' not found.${C_RESET}" >&2; fail=1; }
    command -v helm   >/dev/null || { echo -e "${C_RED}ERROR: 'helm' not found (needed to render the chart).${C_RESET}" >&2; fail=1; }
    for pair in "8080 tcp" "3000 tcp" "69 udp"; do
        set -- $pair
        if port_in_use "$1" "$2"; then
            echo -e "${C_YELLOW}WARN: port $1/$2 in use — uponlan may already be deployed (deploy will replace it).${C_RESET}" >&2
        fi
    done
    [ -S /var/run/libvirt/libvirt-sock ] \
        || echo -e "${C_YELLOW}WARN: /var/run/libvirt/libvirt-sock not found — the VM console tab will not work.${C_RESET}" >&2
    return $fail
}

# Show context + run preflight without deploying anything.
preview() {
    resolve_deploy_knobs
    show_context
    preflight || return 1
    echo -e "${C_GREEN}preview OK — no deploy performed.${C_RESET}"
}

# Render the Helm chart and feed it to podman play kube (KUBEFILE|-).
kube_play() {
    resolve_deploy_knobs
    helm template uponlan "$CHART" \
        --set image.repository="$UPONLAN_IMAGE_REPO" \
        --set image.tag="$UPONLAN_IMAGE_TAG" \
        --set image.pullPolicy="$UPONLAN_PULL_POLICY" \
        --set endpoint="$ENDPOINT_URL" \
        --set menuVersion="$MENU_VERSION" \
        | sudo podman play kube "$@" -
}

build() {
    sudo podman build -t localhost/uponlan:latest .
}

deploy() {
    resolve_deploy_knobs
    show_context
    preflight || return 1
    if [ "${local_deploy:-0}" = "1" ]; then
        if [ ! -f "$OUTPUT_ROOT/assets/endpoints.yml" ]; then
            echo "[deploy --local] Missing $OUTPUT_ROOT/assets/endpoints.yml"
            echo "[deploy --local] Run './wakemeup.sh -a mirror-assets [target]' first"
            return 1
        fi
        MENU_VER="$(sed -n 's/^set menu_version //p' release/menus/version.ipxe)"
        if [ ! -f "$OUTPUT_ROOT/menu/${MENU_VER}/menus.tar.gz" ]; then
            echo "[deploy --local] Missing $OUTPUT_ROOT/menu/${MENU_VER}/menus.tar.gz"
            echo "[deploy --local] Build the menu artifact first with scripts/release_menu.sh ${MENU_VER}"
            return 1
        fi
        echo "[deploy] deploying uponlan container with local menus+assets"
        # Kill any stale local mirror server (e.g. left by a prior deploy) so
        # the fresh one below binds port 8899 and serves the current output.
        pkill -f "http.server 8899" 2>/dev/null || true
        python3 -m http.server 8899 --directory ./$OUTPUT_ROOT >/dev/null 2>&1 &
    else
        echo "[deploy] deploying uponlan container with remote menus+assets"
    fi
    # Build the local image only for --build / --local; the default pulls ghcr.
    if [ "${build:-0}" = "1" ] || [ "${local_deploy:-0}" = "1" ]; then
        build
    fi
    # --replace makes deploy idempotent: it recreates a running pod instead of
    # failing on the bound ports.
    kube_play --replace
}

destroy() {
    # kube_play --down also runs resolve_deploy_knobs, so the image repo/tag
    # below match the same mode deploy would have used.
    kube_play --down
    # Remove the image for the deployment mode in effect (ghcr pull vs local
    # build), not a hardcoded `localhost/uponlan:latest`. Tolerate a missing
    # image: a prior destroy/redeploy may have already removed it, and `set -e`
    # would otherwise abort the whole action. Removing the ghcr image means the
    # next deploy/redeploy re-pulls the latest published image instead of
    # reusing a stale cached one.
    sudo podman rmi "${UPONLAN_IMAGE_REPO}:${UPONLAN_IMAGE_TAG}" 2>/dev/null || true
}

redeploy() {
    destroy
    deploy
}

logs() {
    sudo podman ps --filter name=uponlan-webapp; echo ""
    sudo podman logs -f $(sudo podman ps --filter name=uponlan-webapp --format "{{.ID}}")
}

connect() {
    # Locate the webapp container by name (the chart names it <pod>-webapp),
    # not by image ancestor — a ghcr deploy has no localhost/uponlan image.
    sudo podman exec -it $(sudo podman ps --filter name=uponlan-webapp --format "{{.ID}}") /bin/sh
}

mirror-assets() {
    bash scripts/release_assets.sh "${asset_target:-}"
    echo "[mirror-assets] local asset output built at ./${OUTPUT_ROOT}"
    if [ -n "${asset_target:-}" ]; then
        echo "[mirror-assets] target: ${asset_target}"
    fi
}

release-menu() {
    # Menu version lives in release/menus/version.ipxe (same source deploy --local
    # and scripts/build_release.sh use). release_menu.sh bumps version.ipxe to it
    # and packs release/output/menu/<ver>/menus.tar.gz (+ releases/latest JSON).
    local menu_ver="$(sed -n 's/^set menu_version //p' release/menus/version.ipxe)"
    if [ -z "$menu_ver" ]; then
        echo "ERROR: no 'set menu_version' line in release/menus/version.ipxe" >&2
        return 1
    fi
    echo "[release-menu] releasing menu ${menu_ver}"
    bash scripts/release_menu.sh "$menu_ver"
}

test-webapp() {
    read -p "Which test layer? [all/unit/integration/e2e/smoke] (default: all): " layer
    layer=${layer:-all}
    case $layer in
        all) cmd="node node_modules/vitest/vitest.mjs run" ;;
        unit|integration|e2e|smoke) cmd="node node_modules/vitest/vitest.mjs run test/${layer}" ;;
        *) echo "Invalid layer: $layer (use all/unit/integration/e2e/smoke)"; exit 1 ;;
    esac

    # Locate the webapp container by name (not image ancestor) so this works
    # after either a ghcr or a local build deploy.
    cid=$(sudo podman ps --filter name=uponlan-webapp --format "{{.ID}}" | head -n1)
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
    echo "Usage: ./wakemeup.sh -a <action> [--local] [--build]"
    echo ""
    echo "Allowed Actions"
    echo "---------------"
    echo "1. build - build uponlan image"
    echo "2. deploy [--local] [--build] - deploy uponlan container; default pulls the GitHub-published image; --build builds the local image; --local serves local menus/assets from release/output"
    echo "3. destroy - destroy uponlan container"
    echo "4. redeploy [--local] [--build] - redeploy uponlan container"
    echo "5. logs - display logs from uponlan container"
    echo "6. connect - connect to uponlan container"
    echo "7. mirror-assets - build local asset output; set asset_target=<os> to build one set, e.g. asset_target=harvester ./wakemeup.sh -a mirror-assets"
    echo "8. test-webapp - run webapp tests inside the container"
    echo "9. preview - show deployment context and run preflight checks (no deploy)"
    echo "10. release-menu - build the menu release (release_menu.sh) for the version in release/menus/version.ipxe"
    echo ""
}

action=""
local_deploy=0
build=0
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
        --build)
            build=1
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
    preview) echo "Action: show deployment context + preflight" ;;
    release-menu) echo "Action: build menu release" ;;
    *) echo "Invalid action: $action"; print_help; exit 1 ;;
esac

exec_cmd
