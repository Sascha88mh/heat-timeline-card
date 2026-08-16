#!/bin/sh
# No framework, no dependencies — just node.
set -e
for f in "$(dirname "$0")"/*.test.mjs; do
  echo "== $(basename "$f")"
  node "$f"
done
