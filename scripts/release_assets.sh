#!/bin/bash
set -e

mkdir -p release/mirror
for i in $(ls release/assets/*/setting.sh); do
    os=$(basename $(dirname $i))
    echo "Processing $os"
    cd ./release/assets
    NO_RESUME=1 OUTPUT_DIR=../mirror ./build.sh "$os"
    cd -
done
