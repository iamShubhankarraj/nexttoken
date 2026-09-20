# Next Token — UI Prototype

Interactive prototype of the **Next Token** browser UI: Arc-style sidebar, spaces,
command bar, split view, and an agent copilot panel. This is the actual product
UI codebase in its early form — not a mockup. State lives in a reducer
(`src/store.tsx`) deliberately shaped like the events the real C++ bridge will
emit, so this code survives the transition from prototype to product.

**No credentials or API keys anywhere in this project.** The copilot's replies
are mocked (`mockReply` in `src/components/Copilot.tsx`) and clearly labeled.

## Run it

```bash
npm install
npm run dev      # hot-reload dev server, usually http://localhost:5173
npm run build    # type-check + production build into dist/
npm run preview  # serve the production build locally
```

Requires Node 18+.

## What's implemented

- **Sidebar** (`src/components/Sidebar.tsx`) — three tiers: favorites dock,
  pinned tabs + collapsible folders, ephemeral "Today" tabs. Idle unpinned tabs
  auto-archive after 45s (amber dot warns first); the Archive section restores
  them. The Today list renders through a virtualized list (`VirtualList.tsx`),
  so only the visible window is mounted with hundreds of tabs.
- **Spaces** — Research / Build / Chill, each with own tabs, pins, favorites,
  and accent color. Switch via sidebar icons or `Ctrl/⌘+1…4` (animated).
- **Command bar** (`⌘/Ctrl+K` or `⌘/Ctrl+T`) — fuzzy search across tabs,
  bookmarks, history, spaces, and actions. Arrow keys + Enter, URL detection.
- **Tab content** — mock pages: start page, two articles, a perf dashboard,
  and generated stand-ins for any other URL.
- **Split view** — toolbar button or command bar → "Split view…" → click a
  second tab in the sidebar. Draggable divider, 20–80% clamp.
- **Copilot panel** — page-context indicator, suggestion chips, mocked
  page-aware replies, typing indicator. Toggle with the sparkles button or
  `⌘/Ctrl+.`.
- **Top strip** — domain-only URL pill (click to edit + navigate),
  prev/next tab, sidebar toggle.
- **Shortcuts**: `⌘/Ctrl+K|T` command bar · `⌘/Ctrl+1–4` spaces ·
  `⌘/Ctrl+S` sidebar · `⌘/Ctrl+.` copilot · `Esc` cancel/close.

## Project layout

```
src/
  App.tsx            # shell: layout, shortcuts, per-space accent var
  store.tsx          # central reducer — mirrors future bridge events
  types.ts           # TabItem / Space / Folder / ArchivedTab …
  data.ts            # demo seed data + domain→icon map
  index.css          # theme, spring-feel keyframes, scrollbars
  components/
    Sidebar.tsx      # space switcher, favorites, pinned, today, archive
    VirtualList.tsx  # fixed-row windowing for tab rows
    CommandBar.tsx   # fuzzy search + actions
    TopStrip.tsx     # minimal top bar, domain-only URL
    TabArea.tsx      # active tab / split view + draggable divider
    Pages.tsx        # mock page renderers (start/article/dashboard/generic)
    Copilot.tsx      # agent panel (mocked replies)
```

## Notes for the product build

- Replace `PageRenderer` panes with `WebContentsView`s; keep the split layout
  here in the UI layer.
- Replace the in-memory store's seed with bridge-dispatched actions; the
  action shapes (`ACTIVATE_TAB`, `ARCHIVE_TAB`, …) are already bridge-shaped.
- Replace `mockReply` with the real agent runtime (CDP loop → LLM); feed the
  context chip from the AX-tree/DOM snapshot.
- `VirtualList` is the pattern for all long lists (tabs, history, downloads).
