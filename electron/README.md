# Next Token v0.1 — real browser (Electron)

A real Chromium-based desktop browser with an Arc-style interface, a BYOK AI
agent that can operate the browser, voice control, and gated agent terminal
access. This is `v0.1` of the Next Token project — see `../PLAN.md` for the
long-term (Chromium-fork) plan.

## Install (macOS, Apple Silicon)

1. Download `Next Token-0.1.0-arm64.dmg` from `release/` (or build it below).
2. Open the dmg, drag **Next Token** into Applications.
3. **Gatekeeper:** the app is unsigned, so macOS will block the first launch.
   Right-click (or Control-click) **Next Token** in Applications → **Open** →
   **Open** again in the dialog. You only do this once.

Alternatively use the `.zip` build: unzip, move to Applications, same
right-click → Open dance.

## Build from source

```bash
cd electron
npm install
npm run dev      # dev: hot-reload renderer + main
npm run build    # typecheck + production build -> dist/
npm run dist     # build + electron-builder -> release/*.dmg + *.zip (mac arm64)
npm run smoke    # launch the built app headfully, verify bridge + webview + nav
```

Notes:
- `npm run dist` needs no Apple Developer account — the app is unsigned
  (`identity: null`). You must keep the right-click → Open flow above.
- Full Chromium-compile work (PGO/ThinLTO/SIMD tiers) belongs to the
  long-term fork plan in `../PLAN.md`; this v0.1 ships real Chromium via
  Electron.

## BYOK — bring your own model

Settings → **AI Provider**:

1. Pick a preset: **OpenAI**, **Anthropic**, **OpenRouter**, **Ollama (local)**,
   or **Custom** (any OpenAI-compatible endpoint URL).
2. Enter your API key (not needed for Ollama) and the model id
   (e.g. `gpt-5`, `claude-opus-4-6`, `qwen3:8b`).
3. **Test connection** — the app pings the provider before saving.

The key is stored in the OS keychain via Electron `safeStorage` (macOS
Keychain on your Mac) — it never touches disk in plaintext and is never sent
anywhere except your provider's API. Both OpenAI-compatible
`/chat/completions` and Anthropic `/v1/messages` tool-call formats are
supported.

## The agent

The side-panel agent runs a **perceive → plan → act → verify** loop in the
main process:

- **Perceives** the active tab via the debugger protocol: URL, title, and a
  compressed interactive-element snapshot (no screenshots unless needed).
- **Acts** with tools: navigate, click, fill, scroll, key presses, text
  extraction, tab management, and terminal commands. Click/fill actuate via
  CDP input dispatch (`DOM.resolveNode` + `Input.*`) with an injected-JS
  fallback when the debugger can't attach.
- **Security:** page content is treated as **untrusted data** — it is
  summarized, never obeyed. The system prompt hard-codes this, and a
  prompt-injection test mindset is part of the roadmap.

## Voice control

Click the mic button (or `Alt+V`): say **"new tab"**, **"close tab"**,
**"go to youtube.com"**, **"go back"**, **"reload"**, **"summarize this page"**
(sent to the agent), **"open settings"**, **"switch to Research"**. You can also
dictate into the agent chat box. Toggle spoken replies in Settings.

Note: the Web Speech API needs microphone permission and network access to
the speech service; on first use your browser/OS will ask.

## Terminal access (the computer-control feature)

The agent has a `run_terminal` tool — and **every single invocation shows a
native confirmation dialog** with the exact command and working directory
before anything executes. No silent execution, ever. Cancel the dialog and the
agent is told you declined; it will offer alternatives instead.

## Themes

Token-driven (`src/shared/ipc.ts` is the one file that defines them):
warm-charcoal dark system, one ember-amber accent (`#E8A33D`), desaturated
per-Space hues. The theme editor gives each Space an Arc-style color pair that
re-skins the chrome when you switch. Corner roundness, surfaces, and dark/light
are adjustable per Space and persist.

## Architecture notes

- Tabs are `<webview>` guests; the main process owns their `WebContents`
  (events, navigation, debugger-based perception) via `tabsAttach`.
- State flows main → renderer as snapshots over IPC (`window.nt`); the
  renderer never touches Electron directly.
- Per-site restyling ("Boosts", Arc-style) is a planned follow-up: the store
  already persists `SiteBoost`s and `tabs.ts: maybeInjectBoost` is the marked
  injection point. No UI yet.
- Split view and auto-archive (12h default, like Arc) are built in.

## Known v0.1 limitations

- Unsigned: Gatekeeper right-click → Open required (see above).
- All tab webviews stay mounted (hidden ones keep running) — fine for normal
  use, not yet optimized for 100+ tabs.
- Voice needs mic permission + network; quality depends on the OS speech service.
- Key storage is OS-keychain only (macOS Keychain via Electron safeStorage).
  If the OS keychain is unavailable the app refuses to save the key rather
  than writing it in plaintext.
