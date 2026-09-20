# Next Token

An Arc-level, genuinely fast, agentic web browser — built on Chromium.

**Status:** Phase 0 — foundation. See `../browser-plan/PLAN.md` for the full build plan.

## Layout

| Path | What lives here |
|---|---|
| `next-token/` | Our C++ code: the bridge layer (tabs, navigation, history, sessions, profiles, CDP access for the agent), fork identity, startup patches |
| `ui/` | The entire browser UI as a hot-reloadable web app (React + TypeScript): sidebar tabs, spaces, command bar, split views, agent copilot |
| `patches/` | Numbered patch series applied over the pinned Chromium milestone (quilt-style). Our diff stays minimal and rebaseable |
| `build/` | GN args incl. the speed recipe (`args.gn`), toolchain notes |
| `docs/` | `ARCHITECTURE.md`, `REBASE.md` (the rebase procedure), benchmark methodology |
| `.github/workflows/` | CI: full Chromium builds with sccache, benchmark harness, rebase checks |

## The rules

1. **Patch-set discipline.** All original code lives in `next-token/` + `patches/`. We never fork the Chromium source wholesale. Rebases must stay mechanical.
2. **Keep the C++ diff minimal.** UI lives in `ui/` (web tech). Every line of C++ is a line that can conflict next month.
3. **No placebo speed work.** Only measured wins ship. Benchmarks gate releases.
4. **Security from v1.** The agent gets confirmation UX and provenance tagging from day one.

## Quick start (UI development)

```bash
cd ui
npm install
npm run dev
```

The UI runs hot-reloaded against a prebuilt base binary during development — no Chromium compile needed for UI work.

## Full builds

Full Chromium builds happen in CI only (see `.github/workflows/chromium-build.yml`).
This machine cannot build Chromium (needs 150–250 GB disk, 16 GB+ RAM, hours per build).
