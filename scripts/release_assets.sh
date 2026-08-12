#!/bin/bash
set -e

mkdir -p release/mirror/releases/download
target="${1:-}"

for i in $(ls release/assets/*/setting.sh); do
    os=$(basename $(dirname $i))
    if [ -n "$target" ] && [ "$os" != "$target" ]; then
        continue
    fi
    echo "Processing $os"
    cd ./release/assets
    NO_RESUME=1 OUTPUT_DIR=../mirror ./build.sh "$os"
    cd -
done

# Create a GitHub-like releases/latest response for local testing.
cat > release/mirror/releases/latest <<'EOF'
{"tag_name":"local"}
EOF

# Re-root the raw build output into GitHub-style release URLs.
for d in release/mirror/*/*/*/releases/*/; do
    rel="${d#release/mirror/}"
    arch="${rel%%/*}"; rel="${rel#*/}"
    os="${rel%%/*}";   rel="${rel#*/}"
    ver="${rel%%/*}"
    key="${os}-${ver}-${arch}"
    mkdir -p "release/mirror/releases/download/${key}"
    cp "$d"* "release/mirror/releases/download/${key}/"
done
