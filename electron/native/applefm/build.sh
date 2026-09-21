#!/bin/bash
# Build applefm-bridge and install it where Next Token looks for it.
#
# Run on a Mac with the macOS 26 SDK (ships with Xcode 26+ or the macOS 26 /
# Tahoe command line tools). The Swift toolchain itself may be older than 6.2:
# the package targets macOS 13+ and gates every FoundationModels API behind
# #available(macOS 26, *). The script:
#   1. checks the environment (macOS 26+, Swift/Xcode CLT, macOS 26 SDK),
#   2. builds the release binary with `swift build`,
#   3. installs it into every writable candidate location the Electron app
#      probes (see AppleFmClient.binaryCandidates in src/main/models/applefm.ts):
#        - /Applications/Next Token.app/Contents/Resources/sidecars
#        - ~/Applications/Next Token.app/Contents/Resources/sidecars
#        - <repo>/electron/resources/sidecars   (dev fallback; also what
#          electron-builder copies into the packaged app via extraResources)
#   4. smoke-tests the installed binary with --probe.
#
# After this, restart Next Token: Settings → Models shows Apple Foundation
# Models as Available (given macOS 26+ with Apple Intelligence enabled).
set -euo pipefail

cd "$(dirname "$0")"
REPO_SIDECARS="$(pwd)/../../resources/sidecars"
APP_NAME="Next Token"

die() { echo "error: $1" >&2; exit 1; }
info() { echo "$1"; }

# -- environment checks -------------------------------------------------------
[[ "$(uname)" == "Darwin" ]] || die "this script must run on a Mac (found $(uname))."

OS_VER="$(sw_vers -productVersion 2>/dev/null || echo "0")"
OS_MAJOR="${OS_VER%%.*}"
if ! [[ "$OS_MAJOR" =~ ^[0-9]+$ ]] || [[ "$OS_MAJOR" -lt 26 ]]; then
  die "macOS 26 (Tahoe) or later is required — Apple Foundation Models doesn't exist on older macOS (found $OS_VER)."
fi

command -v swift >/dev/null 2>&1 || die "Swift not found — install Xcode 26+ from the App Store, or run: xcode-select --install"
command -v xcrun >/dev/null 2>&1 || die "xcrun not found — install the Xcode 26+ command line tools: xcode-select --install"

# The FoundationModels framework ships with the macOS 26 SDK (via Xcode 26+ or
# the macOS 26 / Tahoe command line tools).
SDK_VER="$(xcrun --show-sdk-version 2>/dev/null || echo "0")"
SDK_MAJOR="${SDK_VER%%.*}"
if [[ "$SDK_MAJOR" =~ ^[0-9]+$ ]] && [[ "$SDK_MAJOR" -lt 26 ]]; then
  die "macOS 26 SDK not found (SDK reports $SDK_VER) — install Xcode 26+ and select it: sudo xcode-select -s /Applications/Xcode.app"
fi

SDK_PATH="$(xcrun --show-sdk-path 2>/dev/null || true)"
if [[ -z "$SDK_PATH" || ! -e "$SDK_PATH/System/Library/Frameworks/FoundationModels.framework" ]]; then
  die "FoundationModels.framework not found in the macOS SDK (${SDK_PATH:-unknown}) — install Xcode 26+ from the App Store, then select it: sudo xcode-select -s /Applications/Xcode.app"
fi

# -- build --------------------------------------------------------------------
info "Building applefm-bridge (release)…"
swift build -c release

BIN="$(swift build -c release --show-bin-path)/applefm-bridge"
[[ -x "$BIN" ]] || die "build succeeded but no binary at $BIN"

# -- install ------------------------------------------------------------------
CANDIDATES=()
[[ -d "/Applications/${APP_NAME}.app" ]] && CANDIDATES+=("/Applications/${APP_NAME}.app/Contents/Resources/sidecars")
[[ -d "$HOME/Applications/${APP_NAME}.app" ]] && CANDIDATES+=("$HOME/Applications/${APP_NAME}.app/Contents/Resources/sidecars")
CANDIDATES+=("$REPO_SIDECARS")

installed=0
for dir in "${CANDIDATES[@]}"; do
  if mkdir -p "$dir" 2>/dev/null && cp -f "$BIN" "$dir/applefm-bridge" 2>/dev/null; then
    chmod +x "$dir/applefm-bridge"
    info "Installed: $dir/applefm-bridge"
    installed=1
    INSTALLED_BIN="$dir/applefm-bridge"
  else
    info "Skipped (not writable): $dir"
  fi
done
[[ "$installed" == "1" ]] || die "could not install the bridge anywhere (tried ${#CANDIDATES[@]} locations)."

# -- smoke test ---------------------------------------------------------------
info "Smoke test: ${INSTALLED_BIN} --probe"
PROBE_OUT="$("${INSTALLED_BIN}" --probe 2>/dev/null || echo '{"available":false,"reason":"probe failed to run"}')"
info "$PROBE_OUT"
if [[ "$PROBE_OUT" == *'"available":true'* ]]; then
  info "OK — Apple Foundation Models is ready. Restart Next Token."
elif [[ "$PROBE_OUT" == *'"available":false'* ]]; then
  info "Bridge runs. macOS reports the model itself unavailable (see reason above) —"
  info "enable Apple Intelligence in System Settings, then restart Next Token."
else
  die "unexpected probe output — the bridge may be broken."
fi
