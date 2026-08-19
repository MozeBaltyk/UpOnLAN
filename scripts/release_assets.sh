#!/bin/bash
set -e

mirror_root="release/output"
target="${1:-}"

# A full (untargeted) run resets the mirror; a targeted run adds/refreshes
# just that asset set on top of what is already there.
if [ -z "$target" ]; then
    rm -rf "$mirror_root"
fi
mkdir -p "$mirror_root/releases/download"

for i in $(ls release/assets/*/setting.sh); do
    os=$(basename $(dirname $i))
    if [ -n "$target" ] && [ "$os" != "$target" ]; then
        continue
    fi
    echo "Processing $os"
    cd ./release/assets
    NO_RESUME=1 OUTPUT_DIR=../output MIRROR_LAYOUT=github ./build.sh "$os"
    cd -
done

# Create a GitHub-like releases/latest response for local testing, but only
# when release_menu.sh has not already pointed it at a real menu version.
if [ ! -f "$mirror_root/releases/latest" ]; then
    cat > "$mirror_root/releases/latest" <<'EOF'
{"tag_name":"local"}
EOF
fi

if [ ! -f "$mirror_root/endpoints.yml" ]; then
    cat > "$mirror_root/endpoints.yml" <<'EOF'
endpoints: {}
EOF
fi
