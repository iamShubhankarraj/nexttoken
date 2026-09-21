# Next Token — Browser UI Research
**Date:** 2026-09-20 · **Purpose:** ground the Next Token interface in what real users praise, hate, and consider "premium" — and kill the "vibe coded" feel of the current prototype.

---

## 1. Arc's theme system — how it works, what users love

**Mechanics (verified across multiple sources):**
- **Per-Space themes.** Each Space (Work, Life, Side Projects…) gets its own theme: a custom color pair that tints the entire browser chrome (sidebar, toolbar, accents). Switching Spaces visibly re-skins the browser — this is the single most "delight" moment reviewers mention. ([XDA](https://www.xda-developers.com/arc-browser-features-google-chrome-needs-to-steal-to-win-me-back-over/), [Instagram reel demo](https://www.instagram.com/reel/DYzsE9ZSYL7/))
- **Boosts — per-site theming.** Boosts let users restyle *individual websites*: change colors, fonts, force dark mode on bright pages, remove elements with the "Zap" tool (e.g. nuking YouTube Shorts / Twitter Trending), and inject custom CSS/JS. Multiple Boosts per site, toggleable with one click, shareable with friends, plus a community **Boost Gallery** with dozens of user-made presets. Boost 2.0 added a no-code color/font picker on top of the code editor. ([SlashGear](http://www.slashgear.com/1634601/best-arc-browser-features/), [9to5Mac](https://9to5mac.com/?p=884684), [Fast Company](https://www.fastcompany.com/90970493/why-arc-not-chrome-is-the-best-browser-out-there), [The Sweet Setup](http://thesweetsetup.com/first-look-arc-browser/))
- **Design language.** "Clean and minimalistic… rounded corners and simple icons to perfection, giving the browser a cozy feel." ([CPSRadar](https://www.cpsradar.com/post/arc-browser-is-worth-all-the-hype))

**What users specifically love:**
- The browser "gets out of the way" — minimal chrome, sidebar collapses, keyboard-first navigation (Cmd+S sidebar, Cmd+T command bar). ([Popular Science](https://www.popsci.com/diy/arc-browser-tips/), Noir Studio ad via [Instagram](https://www.instagram.com/reel/DZR9pExMpXB/))
- Per-Space theming makes context-switching *feel* different, not just look different — reviewers call it out as the feature that makes Spaces stick.
- Boosts are repeatedly called "my favorite feature" / "where Arc truly shines" / "set a benchmark in customization." The Zap tool (delete any page element) is the crowd-pleaser demo.
- Power users stay for: keyboard shortcuts, profile handling, window management, Air Traffic Control (URL→Space routing rules), Peek windows (Shift-click link preview), auto-archiving tabs. ([Threads — Daniel Kuney](https://www.threads.com/@danielkuney/post/DZ5l9PolGLv), [@marclar.tech](https://www.instagram.com/reel/Dc06KF8xGhY/))
- Emotional attachment is real: "I would cry if I lost it" (creator [Chiara Antonucci](https://www.instagram.com/reel/Dc6hRlAIWAg/), still on Arc after its discontinuation); "Name a better browser than Arc. I'll wait." ([@shirshakchavan via Instagram](https://www.instagram.com/p/Dca_CEfMv3K/))

**Famous community angle:** the Boost Gallery (user-shared site themes) is the community artifact — Next Token should plan an equivalent theme/Boost gallery from day one.

---

## 2. What people currently praise as GOOD browser UI

**The consensus winners (2026):** Arc's ideas live on through **Zen Browser** (open-source Firefox fork, 41K+ GitHub stars, "expanding faster than Arc ever did"). Zen is the most-praised current browser UI. Dia (The Browser Company's AI successor) gets credit for clean design but not love.

**Specific UI details that get complimented, with sources:**
- **Vertical sidebar tabs** — the defining win. "Vertical tabs are plain better… you gain extra vertical space, avoid the chaotic appearance of dozens of horizontal tabs." ([@Dara via Instagram](https://www.instagram.com/reel/DUgjvJ_iSS0/)). Chrome itself added vertical tabs in 2026, validating the trend ([Facebook dev group](https://www.facebook.com/groups/devhubb/permalink/1561181664942323/)). Even a Threads user "obsessed" that Chrome copied Arc ([@dignifiedpauper](https://www.threads.com/@dignifiedpauper/post/Dcbctq5jnFX)).
- **Command bar / command palette** — cited as a decisive factor keeping users on Arc ("command palette and profile management are decisive factors"). Cmd+T as *the* primary interface, not the address bar.
- **Glance / Peek previews** — Zen's Glance (modifier-click a link → floating modal, dismiss to return, no new tab) is called a standout workflow innovation; Arc's Peek (Shift-click) the same. ([@peesamac](https://www.threads.com/@peesamac/post/DW_1RjaE4Y_))
- **Compact mode** — auto-hiding sidebar for a cleaner screen (Zen). Praised as the "gets out of your face" mechanism. ([werd.io](https://werd.io/why-im-all-in-on-zen-browser/), [Facebook AI World](https://www.facebook.com/groups/aiworldopen/permalink/1406822531252300/))
- **Split view** — universally expected now; Zen does a grid layout, Arc 2-tab. Table stakes.
- **Auto-archiving tabs** — "tabs you'll never close" → auto-cleanup every 12h (Arc default). Removes tab-hoarding guilt.
- **Spaces/Workspaces with per-space identity** — separate tabs + folders + themes per context.
- **Zen Mods** — 79+ community CSS mods for deep UI customization; the open-source answer to Boosts. Community theming is a *feature category*, not a nice-to-have.
- **Minimal chrome, maximal content** — "It doesn't just browse the internet… gets it out of your way." Fast, calm, keyboard-driven.
- **Delightful motion** — Arc's springy animations and the Noir Studio launch videos show motion *is* part of the perceived quality ("smooth transitions, floating UI cards").

---

## 3. What gets COMPLAINED about

- **Vivaldi sluggishness (the cautionary tale for a web-tech UI).** Its UI is HTML/CSS/JS and users *feel* it: "It redraws the entire tab bar for a 16×16 animated icon" (audio speaker animation → full tab-bar repaint, 100% of a CPU core); YouTube fullscreen transitions ~3s slower than Chrome/Edge/Firefox; "slowness comes from using HTML/CSS/JS for the UI, instead of a C++ UI framework." ([Hacker News](https://news.ycombinator.com/item?id=27445859), [Vivaldi forum](https://forum.vivaldi.net/post/472668), [PCWorld](https://www.pcworld.com/article/420445/vivaldi-browser-review-powerful-features-outshine-slightly-sluggish-performance.html)). **Lesson for Next Token:** our React UI must virtualize lists, avoid layout thrash, keep animations compositor-only (transform/opacity), and never re-render the whole sidebar for a favicon pulse.
- **Arc bloat + abandonment.** Long-term users report Arc "has become noticeably slower" with performance issues; The Browser Company discontinued Arc feature development (May 2025) to chase Dia, then got acquired by Atlassian — trust collapse: "They could just as easily abandon it like Arc the moment the next trend shows up." ([MakeUseOf](https://www.makeuseof.com/arc-supposed-successor-not-even-close/))
- **Dia: instability + battery.** "Increasing instability," "suboptimal battery consumption" — AI browsers ship half-baked. ([@robin.ebers](https://www.threads.com/@robin.ebers/post/DWS4xKHFIEP))
- **Chrome clutter.** Horizontal tabs "become crowded and cluttered"; the browser is "too slow and outdated… shouldn't feel messy." ([XDA](https://www.xda-developers.com/arc-browser-features-google-chrome-needs-to-steal-to-win-me-back-over/), [Facebook AI ad](https://www.facebook.com/reel/1002926625682348/))
- **Vertical-tab skeptics exist.** "Wasted pixels," "odd choices" — a minority prefers horizontal tabs for screen real estate; a collapsible/compact sidebar answers them. ([@jeremyburge](https://www.threads.com/@jeremyburge/post/DW2x0rwgfNV))
- **Design-incoherence critique (directly relevant to "vibe coded").** Designer Bear Liu's viral critique: Arc has only ~0.1% market share and three product-design failures — **a visual-language mismatch that creates incoherent UI communication**, an overly complex entity-setup, and acquisition without conversion. ([@Bear Liu via Instagram](https://www.instagram.com/reel/DZSLBAOiqIA/)). Incoherent visual language is exactly what "vibe coded" means.
- **Zen's rough edges.** Firefox quirks, DRM streaming issues, connects to Google IPs at startup unless fixed, sync limited. ([dev.to](https://dev.to/gruszdev/i-tried-6-next-gen-browsers-heres-what-i-found-5bpf), [YouTube — Tinkr](https://www.youtube.com/watch?v=CZfSxXWLGtw))

---

## 4. "Premium" vs "vibe coded" — the visual language

Synthesized from the [Dark Mode Premium guide](https://github.com/heiberg-industries/designbrief/blob/HEAD/styles/dark-mode-premium.md), the [Premium UI/UX skill](https://github.com/justasallen/5th_row/blob/HEAD/.opencode/skills/ui-ux-premium/SKILL.md), the [terafab design system](https://github.com/voynan/landing-page/blob/HEAD/docs/terafab-inspired-ux-ui-design-system.md), and [Medium dark-mode best practices](https://medium.com/@webfolks.pr/dark-mode-design-when-and-how-to-use-it-effectively-29c4fc33bc29):

**What reads as premium:**
1. **Layered dark surfaces, never flat black.** 3–5 distinct elevation levels (deep base → cards → raised → overlay), each subtly lighter. "If all your dark surfaces are the same shade, you've missed the point."
2. **One restrained accent, ~5:95 ratio.** Accent = light in darkness: small, precise, luminous. Subtle glow on the active element only — never slathered across headers/backgrounds.
3. **Strict text hierarchy.** 3–4 opacity levels (primary ~95%, secondary ~65%, tertiary ~40%). Never pure white body text (too harsh), never mid-grays (vanish).
4. **Desaturated everything else.** Avoid fully saturated colors on dark — they feel harsh. Muted, softer hues.
5. **Measured, not decorated.** 1px structural rules, consistent alignment rails, tabular numerals, minimal chrome. (Terafab: "Avoid conventional SaaS cards, bubbly containers, pill buttons, thick borders, colorful icon tiles, and decorative glass panels.")
6. **Typography with intent.** Tight tracking on headings, adequate weight on dark (thin fonts disappear), one family, clear scale.

**What reads as "vibe coded" (the failure list):**
- Purple-blue gradients as the brand (the #1 AI-generated cliché) — our current prototype's violet accent is exactly this.
- Glassmorphism/decorative blur everywhere, bubbly oversized radii, pill buttons, thick borders, colorful icon tiles.
- Multiple competing accent colors on one screen; accent used for large surfaces instead of precise highlights.
- Flat single-shade dark background + pure-white text + mid-gray secondary text (inverted-light-theme look).
- Inconsistent spacing/radii (visual-language mismatch — the Bear Liu critique).
- Gratuitous animation on functional UI; animation that isn't compositor-cheap.

---

## 5. Proposed design tokens for Next Token

Dark-first, sophisticated, **no purple-blue gradient cliché**. Direction: *warm charcoal + single ember accent* — closer to a precision instrument (Linear/Vercel restraint) than a SaaS dashboard.

### Color — surfaces (warm-neutral, layered)
| Token | Value | Use |
|---|---|---|
| `--nt-bg-base` | `#0B0B0D` | app base, deepest layer |
| `--nt-bg-subtle` | `#101013` | sidebar background |
| `--nt-bg-raised` | `#16161A` | cards, panels |
| `--nt-bg-overlay` | `#1E1E24` | popovers, command bar, modals |
| `--nt-bg-hover` | `#232329` | hover states |
| `--nt-border` | `rgba(255,255,255,0.08)` | 1px structural rules |
| `--nt-border-strong` | `rgba(255,255,255,0.14)` | focused/emphasized edges |

### Color — text
| Token | Value | Use |
|---|---|---|
| `--nt-text-1` | `#F4F2ED` (warm off-white, 95%) | primary |
| `--nt-text-2` | `rgba(244,242,237,0.64)` | secondary |
| `--nt-text-3` | `rgba(244,242,237,0.40)` | tertiary / placeholder |
| `--nt-text-faint` | `rgba(244,242,237,0.24)` | disabled, ghost labels |

### Color — accent (ONE accent: ember amber)
| Token | Value | Use |
|---|---|---|
| `--nt-accent` | `#E8A33D` | active tab indicator, primary actions, focus rings |
| `--nt-accent-soft` | `rgba(232,163,61,0.14)` | active fills, selection wash |
| `--nt-accent-glow` | `0 0 16px rgba(232,163,61,0.28)` | glow on the single active element only |
| `--nt-accent-text` | `#0B0B0D` | text on accent fills |

Ratio target: accent pixels ≈ 5% of chrome. Accent never fills large surfaces.

### Color — per-Space identity (curated, desaturated — Arc-style theming without neon)
| Space | Token | Value |
|---|---|---|
| Research | `--nt-space-1` | `#7FA6A3` muted teal |
| Build | `--nt-space-2` | `#9CAF88` sage/moss |
| Chill | `--nt-space-3` | `#C08552` clay/ochre |
| (extra) | `--nt-space-4` | `#8E9AAF` slate |
| (extra) | `--nt-space-5` | `#A67C8E` dusty plum |
| (extra) | `--nt-space-6` | `#B08968` warm taupe |
Space color tints: the active-tab indicator, space icon, and a 2px top-edge wash on the sidebar — never the whole sidebar background.

### Color — semantics (desaturated)
- success `#6FA287` · warning `#D9A441` · danger `#D97362` · info `#7FA6C9` — all muted, never neon.

### Radii (consistent scale — no bubbly randomness)
- `--nt-r-sm: 6px` — buttons, inputs, tab rows
- `--nt-r-md: 10px` — cards, panels, sidebar sections
- `--nt-r-lg: 14px` — command bar, modals, large popovers
- `--nt-r-full` — badges and avatar dots ONLY, never buttons

### Type scale
- Family: system stack (`-apple-system, Inter, "SF Pro"`) — native feel, zero load cost. Mono: `ui-monospace, "SF Mono"` for URLs/shortcuts/terminal.
- Sidebar rows: 13px/500 · Headings: 15px/600 tight tracking (-0.01em) · Command bar input: 15px · Body: 13px · Micro-labels: 11px/600 uppercase +0.06em tracking, `--nt-text-3`
- Never below 11px. Tabular numerals for counts/shortcuts.

### Spacing rhythm
- 4px base grid; component padding in 8px steps (8/12/16/24). Sidebar: 8px outer padding, 4px row gaps, 28–32px tab rows. Command bar: 16px padding, 12px item rows.

### Motion (the anti-Vivaldi rules)
- Functional UI: `cubic-bezier(0.32, 0.72, 0, 1)`, 180–240ms, transform/opacity only (compositor-cheap — never re-layout the sidebar for an animation).
- One gentle overshoot allowed on *delight* moments only (space switch, panel open): `cubic-bezier(0.34, 1.3, 0.64, 1)`, ≤320ms.
- Popovers/command bar: fade + 4px rise, 150ms.
- Respect `prefers-reduced-motion`. No perpetual animations except a 16px loading shimmer — and it must NOT trigger parent repaints (the Vivaldi speaker-icon bug is the canonical failure).

### The "not vibe coded" checklist (enforce in review)
1. No purple/blue gradients anywhere; no gradient larger than a 2px wash.
2. One accent color per screen; Space color is identity, not decoration.
3. Borders are 1px `white/8%` — no thick borders, no colorful icon tiles.
4. Radii come from the scale — no ad-hoc values.
5. Every surface maps to an elevation token — no flat `#000` + white text.
6. Icons: single Lucide set, 1.75px stroke, 16px standard — no mixed icon styles.
7. Sidebar rows align to one left rail; counts/shortcuts right-align with tabular numerals.

---

### Sources
- Arc themes/Boosts: [SlashGear](http://www.slashgear.com/1634601/best-arc-browser-features/), [9to5Mac](https://9to5mac.com/?p=884684), [Fast Company](https://www.fastcompany.com/90970493/why-arc-not-chrome-is-the-best-browser-out-there), [The Sweet Setup](http://thesweetsetup.com/first-look-arc-browser/), [Popular Science](https://www.popsci.com/diy/arc-browser-tips/), [XDA](https://www.xda-developers.com/arc-browser-features-google-chrome-needs-to-steal-to-win-me-back-over/), [CPSRadar](https://www.cpsradar.com/post/arc-browser-is-worth-all-the-hype)
- Comparisons: [dev.to — 6 next-gen browsers](https://dev.to/gruszdev/i-tried-6-next-gen-browsers-heres-what-i-found-5bpf), [samnesler.com comparison](https://github.com/the-snesler/samnesler.com/blob/HEAD/posts/arc-zen-dia-aside.mdx), [MakeUseOf — Arc's successor](https://www.makeuseof.com/arc-supposed-successor-not-even-close/), [werd.io — all-in on Zen](https://werd.io/why-im-all-in-on-zen-browser/), [Sigma — Zen vs Arc 2026](https://sigmabrowser.com/blog/zen-browser-vs-arc-which-browser-is-better-for-productivity-in-2026)
- Complaints: [HN — Vivaldi unbearable](https://news.ycombinator.com/item?id=27445859), [HN — Vivaldi vs Chrome](https://news.ycombinator.com/item?id=25789159), [Vivaldi forum — UI slower](https://forum.vivaldi.net/post/472668), [PCWorld — Vivaldi review](https://www.pcworld.com/article/420445/vivaldi-browser-review-powerful-features-outshine-slightly-sluggish-performance.html)
- Social: Instagram [@marclar.tech](https://www.instagram.com/reel/Dc06KF8xGhY/), [@heychiara__](https://www.instagram.com/reel/Dc6hRlAIWAg/), [@Dara](https://www.instagram.com/reel/DUgjvJ_iSS0/), [@shirshakchavan](https://www.instagram.com/p/Dca_CEfMv3K/), [Noir Studio Arc ad](https://www.instagram.com/reel/DZR9pExMpXB/); Threads [@danielkuney](https://www.threads.com/@danielkuney/post/DZ5l9PolGLv), [@jeremyburge](https://www.threads.com/@jeremyburge/post/DW2x0rwgfNV), [@robin.ebers](https://www.threads.com/@robin.ebers/post/DWS4xKHFIEP), [@peesamac](https://www.threads.com/@peesamac/post/DW_1RjaE4Y_), [@dignifiedpauper](https://www.threads.com/@dignifiedpauper/post/Dcbctq5jnFX), [@actualfrancia](https://www.threads.com/@actualfrancia/post/DRQFJnFESuV); Facebook [devhubb vertical tabs](https://www.facebook.com/groups/devhubb/permalink/1561181664942323/), [AI World — Arc→Zen](https://www.facebook.com/groups/aiworldopen/permalink/1406822531252300/)
- Aesthetic refs: [Dark Mode Premium](https://github.com/heiberg-industries/designbrief/blob/HEAD/styles/dark-mode-premium.md), [Premium UI/UX skill](https://github.com/justasallen/5th_row/blob/HEAD/.opencode/skills/ui-ux-premium/SKILL.md), [terafab design system](https://github.com/voynan/landing-page/blob/HEAD/docs/terafab-inspired-ux-ui-design-system.md), [Medium — dark mode best practices](https://medium.com/@webfolks.pr/dark-mode-design-when-and-how-to-use-it-effectively-29c4fc33bc29)
