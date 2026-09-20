# Architecture

The full plan lives in `~/workspace/browser-plan/PLAN.md`. This is the working summary.

```
┌─────────────────────────────────────────────────────────────┐
│  Next Token UI — ui/ (React + TypeScript, hot-reloadable)    │
│  sidebar tabs · spaces · command bar · splits · side panel   │
│  agent copilot UI · settings · new-tab                       │
├─────────────────────── IPC / bridge ────────────────────────┤
│  C++ bridge — next-token/ (bounded: tabs, navigation,        │
│  history, sessions, downloads, profiles, CDP for the agent)  │
├─────────────────────────────────────────────────────────────┤
│  Chromium fork (ungoogled-chromium patch base + our patches) │
│  Blink · V8 · content · extensions · WebUI side panel host   │
└─────────────────────────────────────────────────────────────┘
```

## Bridge API (to be implemented in `next-token/`)

Versioned IPC surface the web UI calls. v1 scope:

- `tabs.create / .close / .move / .query / .activate`
- `navigation.goBack / .goForward / .reload / .navigate`
- `history.query / .delete`
- `sessions.save / .restore` (for spaces + splits persistence)
- `downloads.list / .pause / .resume / .cancel`
- `profiles.list / .switch` (per-space profiles)
- `agent.cdpSession` — scoped CDP access for the agent runtime

The web UI **never** touches Chromium internals directly. Everything goes through
this bridge. That boundary is what keeps rebases mechanical.

## UI principles

- Virtualized lists everywhere (tabs, history, command-bar results). Vivaldi's
  sluggishness-with-many-tabs is the failure mode we design against from day one.
- Sidebar is the tab strip. There is no top tab bar. Ever.
- Tabs are ephemeral by default; pinned tabs and favorites are explicit.
- Animations: spring physics, ~13px sidebar rows, reduced-motion respected.
- The command bar (`Cmd/Ctrl+T`) is the primary interface, not the address bar.

## Agent runtime

Lives in the privileged UI context. Loop: perceive → plan → act → verify.
Perception = accessibility tree + DOM snapshot, fused and **diffed between steps**.
Tools: navigate, click, fill, scroll, extract, tabs, js-eval. BYOK cloud LLM
(key in OS keychain). Confirmation UX + provenance tagging from v1 — see PLAN.md §7.
