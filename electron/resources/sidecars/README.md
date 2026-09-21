# resources/sidecars/

Native sidecar binaries packaged with the app. electron-builder copies this
directory to `<App>.app/Contents/Resources/sidecars/` (see
`extraResources` in electron-builder.yml), which is the FIRST place
`AppleFmClient` looks for the bridge at runtime.

## applefm-bridge

The Swift sidecar for Apple Foundation Models (macOS 26+). It is NOT checked
into git — it can only be built on a Mac with Xcode 26+:

```bash
cd electron/native/applefm
./build.sh
```

The script installs the binary here (`electron/resources/sidecars/`, the dev
fallback the app also probes) and into any installed copy of the app at
`/Applications` / `~/Applications`. Rebuild + rerun it whenever the Swift
source changes; the packaged app picks it up on the next
`electron-builder` run.
