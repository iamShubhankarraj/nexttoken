# Patch series

Our diff against the pinned Chromium milestone, quilt-style. Applied in order
by `apply.sh` after the ungoogled-chromium base series.

## Numbering

- `0000-0999` — fork identity (name, icons, `nexttoken://` scheme, about page)
- `1000-1999` — speed program (startup deferral, GN arg defaults)
- `2000-2999` — bridge API additions
- `3000-3999` — UI suppression (hide stock tab strip / toolbar, host our UI surface)
- `9000+`       — experimental / local-only (never ship)

## Rules

- One logical change per patch. Name: `NNNN-short-description.patch`.
- Comment the *why* at the top of every patch, with a link to the upstream code
  it touches (file paths get renamed across milestones — the link is the map).
- Keep each patch as small as possible. See `docs/REBASE.md` conflict policy.
- The `-O3` and SIMD-tier compiler changes live here as patches against
  `build/config/compiler/BUILD.gn` — study Thorium's `PATCHES.md`, reimplement,
  don't copy blind.
