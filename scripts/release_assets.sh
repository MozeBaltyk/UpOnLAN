#!/bin/bash
set -e

mirror_root="release/output/assets"
target="${1:-}"
# local (default, /assets/<key>/) vs github (/releases/download/<key>/) layout.
mirror_layout="${MIRROR_LAYOUT:-local}"

# A full (untargeted) run resets the asset mirror; a targeted run adds/refreshes
# just that asset set on top of what is already there. The menu release lives in
# release/output/menu/ (a sibling), so a reset here never touches it.
if [ -z "$target" ]; then
    rm -rf "$mirror_root"
fi
mkdir -p "$mirror_root"

for i in $(ls release/assets/*/setting.sh); do
    os=$(basename $(dirname $i))
    if [ -n "$target" ] && [ "$os" != "$target" ]; then
        continue
    fi
    # Determine the recipe's build type without sourcing setting.sh (sourcing
    # would trigger its `VERSION=$(curl ...)` and other side effects).
    build_type=$(sed -n 's/^BUILD_TYPE=//p' "$i" | head -1)
    build_type="${build_type%\"}"; build_type="${build_type#\"}"
    build_type="${build_type%\'}"; build_type="${build_type#\'}"
    echo "Processing $os"
    cd ./release/assets
    if [ "$build_type" = "direct_file" ]; then
        # direct_file is always catalog-only (vendor sources + metadata, no
        # download). Even for the GitHub-published catalog we keep the local
        # /assets/<key>/ path, because those assets are imported on-demand and
        # then served locally by nginx rather than fetched from GitHub.
        catalog_layout="$mirror_layout"
        [ "$mirror_layout" = "github" ] && catalog_layout="local"
        NO_RESUME=1 OUTPUT_DIR=../output/assets MIRROR_LAYOUT="$catalog_layout" CATALOG_ONLY=1 ./build.sh "$os"
    else
        NO_RESUME=1 OUTPUT_DIR=../output/assets MIRROR_LAYOUT="$mirror_layout" ./build.sh "$os"
    fi
    cd -
done

if [ ! -f "$mirror_root/endpoints.yml" ]; then
    cat > "$mirror_root/endpoints.yml" <<'EOF'
endpoints: {}
EOF
fi
