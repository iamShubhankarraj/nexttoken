# Next Token — C++ bridge layer

This directory will hold our (deliberately small) C++ surface:

- `bridge/` — versioned IPC API: tabs, navigation, history, sessions, downloads,
  profiles, scoped CDP access for the agent runtime
- `identity/` — fork identity: name, icons, `nexttoken://` scheme, about page
- `startup/` — startup-path deferral patches' C++ side

**Rule: keep this directory small.** Every file here is a file that can conflict
on the next Chromium rebase. UI logic lives in `ui/`, not here.

Nothing here yet — Phase 1.
