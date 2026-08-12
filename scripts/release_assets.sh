#!/bin/bash
set -e

mkdir -p release/mirror
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
