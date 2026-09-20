# Rebase procedure

Chromium moves fast (a major milestone roughly every month; zero-days in between —
Chrome had 6 in 2026, 3 in V8). Our fork survives that only if rebasing is boring
and mechanical. This document is the exact procedure.

## Pinned versions

| Component | Current pin |
|---|---|
| Chromium milestone | M153 |
| ungoogled-chromium patch series | tag matching M153 |
| Our patch series | `patches/series` |

Update this table on every rebase.

## The rebase (every ~4 weeks, or immediately for a zero-day)

```bash
# 1. Sync Chromium to the new milestone tag
gclient sync --with_branch_heads --jobs=16

# 2. Re-apply the ungoogled-chromium base patch series
cd src
python3 ../ungoogled-chromium/utils/patches.py apply ../ungoogled-chromium/patches

# 3. Apply OUR patch series (quilt-style, in order)
bash ../patches/apply.sh

# 4. If a patch fails: it shows as a .rej file.
#    Fix it by hand, refresh the patch file, and note the conflict
#    in patches/series (comment line above the patch).
#    Rule: prefer shrinking our patch over forking more Chromium code.

# 5. Regenerate build files and do a full CI build
gn gen out/Default --args='import("//../build/args.gn")'
autoninja -C out/Default chrome

# 6. Run the benchmark harness — any regression vs the previous
#    milestone blocks the release (see docs/BENCHMARKS.md)
```

## Conflict policy

1. If upstream refactored the area, **shrink our patch** to the smallest change that
   still delivers the feature.
2. If our patch no longer applies because the feature moved, **move with it** —
   don't keep a stale hunk alive with fuzz.
3. If a patch conflicts three rebases in a row, that's a design smell: consider
   moving the logic into the web UI layer or the bridge API instead of patching
   Chromium internals.
4. Never "resolve" a conflict by deleting a security-relevant hunk (site isolation,
   sandbox flags, V8 cage). When in doubt, ask.

## Security fast-lane

For a V8/Blink zero-day: skip the milestone rebase, cherry-pick the upstream fix
onto our pin, run `apply.sh`, build, ship. The monthly rebase catches up later.
