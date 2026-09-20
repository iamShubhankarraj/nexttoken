#!/bin/bash
# Build applefm-bridge and install it as an Electron sidecar binary.
# Run on a Mac with Xcode 26+ (macOS 26 SDK with the FoundationModels framework).
set -euo pipefail

cd "$(dirname "$0")"

echo "Building applefm-bridge (release)…"
swift build -c release

BIN_DIR="$(swift build -c release --show-bin-path)"
BIN="$BIN_DIR/applefm-bridge"
if [[ ! -x "$BIN" ]]; then
  echo "error: expected binary not found at $BIN" >&2
  exit 1
fi

OUT_DIR="../../resources/sidecars"
mkdir -p "$OUT_DIR"
cp -f "$BIN" "$OUT_DIR/applefm-bridge"
chmod +x "$OUT_DIR/applefm-bridge"

echo "Installed: $OUT_DIR/applefm-bridge"
