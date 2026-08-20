#!/bin/bash
# Run the release-flow specs in tests/specs/.
#
# Usage: ./tests/specs/run.sh            # run all specs
#        ./tests/specs/run.sh <test>     # run a single module, e.g. test_menu_paths
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ "$#" -eq 0 ]; then
  python3 -m unittest discover -s tests/specs -v
else
  python3 -m unittest -v "$@"
fi
