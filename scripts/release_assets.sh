#!/bin/bash
set -e

for i in $(ls release/assets/*/setting.sh); do
    os=$(basename $(dirname $i))
    echo "Processing $os"
    cd ./release/assets
    ./build.sh "$os"
    cd -
done