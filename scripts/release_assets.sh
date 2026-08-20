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
    echo "Processing $os"
    cd ./release/assets
    NO_RESUME=1 OUTPUT_DIR=../output/assets MIRROR_LAYOUT="$mirror_layout" ./build.sh "$os"
    cd -
done

if [ ! -f "$mirror_root/endpoints.yml" ]; then
    cat > "$mirror_root/endpoints.yml" <<'EOF'
endpoints: {}
EOF
fi
