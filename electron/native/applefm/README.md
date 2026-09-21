# applefm-bridge

A tiny macOS executable that exposes Apple's on-device **Foundation Models**
(the LLM behind Apple Intelligence, macOS 26 / Tahoe and later) to the Next
Token Electron app as a newline-delimited JSON protocol over stdio. No SDK is
needed in the Electron process — the Swift sidecar owns the one framework the
app can't touch from Node.

## Build (on a Mac)

Requires the macOS 26 SDK, which ships `FoundationModels` — via Xcode 26+ or
the macOS 26 (Tahoe) command line tools. The Swift toolchain itself may be
older than 6.2: the package targets macOS 13+ and every FoundationModels API
use is guarded by `#available(macOS 26, *)`.

```bash
cd electron/native/applefm
./build.sh
```

This checks the environment (macOS 26+, macOS 26 SDK with FoundationModels),
runs `swift build -c release`, installs the binary into every writable
candidate location the Electron client probes — the installed app's
`Contents/Resources/sidecars` (both `/Applications` and
`~/Applications`), plus the repo's `electron/resources/sidecars` dev
fallback — and smoke-tests it with `--probe`. After a successful build,
restart Next Token: Settings → Models shows Apple Foundation Models as
Available (given macOS 26+ with Apple Intelligence enabled).

Check it works:

```bash
../../resources/sidecars/applefm-bridge --probe
# {"available":true}
```

## Protocol

**Probe** — `applefm-bridge --probe` prints exactly one line and exits 0:

```
{"available":true}
{"available":false,"reason":"model unavailable: appleIntelligenceNotEnabled"}
```

**Chat** — with no flags the bridge reads JSON lines from stdin and writes one
JSON line per request to stdout:

Request:

```json
{"id":1,"op":"chat","system":"You are a concise assistant.","messages":[{"role":"user","content":"Say hi"}]}
```

Responses (stdout is flushed after every line):

```json
{"id":1,"text":"Hi there."}
{"id":1,"error":"Apple Foundation Models unavailable: …"}
```

Role mapping: `system` (both the top-level field and `role:"system"` messages)
becomes the `LanguageModelSession` instructions; `user` turns are replayed
through `session.respond(to:)`; `assistant` turns are skipped because the
session transcript already carries them. The bridge never exits on a bad
request — it replies with an `error` line and keeps serving. It exits when
stdin reaches EOF.

## Graceful degradation

- **Binary missing** (not built yet, or stripped from the package): the
  TypeScript client reports `available: false` with `setupRequired: true`;
  Settings → Models renders an amber "one-time setup required" card with the
  exact build commands instead of an error, and the model router labels the
  choice accordingly.
- **macOS < 26 or model not ready** (Apple Intelligence off, device ineligible,
  model still downloading): `--probe` returns `available:false` with the real
  `SystemLanguageModel` unavailability reason; every chat request errors the
  same way.
- **Not on macOS at all**: the client never spawns the binary.

Apple Foundation Models does not support tool calling, so the router only uses
this path for tool-free turns.
