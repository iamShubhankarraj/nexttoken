#!/usr/bin/env bash
# Applies our patch series over the pinned Chromium tree (after the
# ungoogled-chromium base series). Run from the repo root.
set -euo pipefail

CHROMIUM_SRC="${CHROMIUM_SRC:-$HOME/chromium/src}"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$CHROMIUM_SRC" ]; then
  echo "error: Chromium checkout not found at $CHROMIUM_SRC" >&2
  echo "set CHROMIUM_SRC or follow docs/REBASE.md to create one" >&2
  exit 1
fi

cd "$CHROMIUM_SRC"
while IFS= read -r patch || [ -n "$patch" ]; do
  # skip blanks and comments
  case "$patch" in ''|'#'*) continue;; esac
  echo "==> applying $patch"
  patch -p1 --forward < "$PATCH_DIR/$patch" || {
    echo "FAILED: $patch — resolve the .rej by hand, then refresh the patch" >&2
    exit 1
  }
done < "$PATCH_DIR/series"
echo "all patches applied cleanly"
