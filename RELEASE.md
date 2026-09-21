# Next Token — release publishing guide (v0.6.2+)

How a new version goes from this repo to users' Macs, including the
in-app update feed (Settings → Updates).

## One-time setup: the update feed

The in-app updater (Settings → Updates) polls a static feed — no server
code, just two files at a public HTTPS base URL:

```
<FEED_BASE>/latest-mac.yml
<FEED_BASE>/Next-Token-<VERSION>-arm64-mac.zip
```

Recommended host: **Cloudflare R2** (free tier, zero egress fees, correct
HTTP semantics). Google Drive is NOT viable for the feed: it returns
403 quota pages and virus-scan interstitials instead of bytes, and
doesn't support the range requests the downloader uses.

### R2 setup (once)

1. Cloudflare dashboard → R2 → create bucket, e.g. `next-token-updates`.
2. Settings → Public access → allow access (or attach a custom domain
   like `updates.nexttoken.app` — nicer than the `r2.dev` URL).
3. Upload the two files per release (below) with `Content-Type`:
   - `latest-mac.yml` → `text/yaml`
   - `*.zip` → `application/zip`
4. Paste the base URL into the app: Settings → Updates → "Update feed"
   → Save. Example: `https://updates.nexttoken.app/mac-arm64`.

Until a feed URL is set, updates stay dormant: the menu item and the
Updates page explain that updates aren't configured yet. Nothing phones
home — the check only runs when a feed URL exists.

### `latest-mac.yml` format

electron-builder emits this file next to the zip on every build
(`release/latest-mac.yml`). Publish it verbatim. Example:

```yaml
version: 0.6.2
files:
  - url: Next-Token-0.6.2-arm64-mac.zip
    sha512: 4f3a…(base64 of the zip)…
    size: 344337754
path: Next-Token-0.6.2-arm64-mac.zip
sha512: 4f3a…(base64 of the zip)…
releaseDate: '2026-09-22T10:30:00.000Z'
```

The app only reads `version`, the first `files[]` entry's
`url`/`sha512`/`size`. URLs may be relative (resolved against the feed
base) or absolute.

### sha512 of the zip

```bash
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha512').update(f.readFileSync('Next-Token-0.6.2-arm64-mac.zip')).digest('base64'))"
```

## Release checklist (every version)

1. Bump `"version"` in `electron/package.json`.
2. `npm run typecheck` — both `tsconfig.node.json` and `tsconfig.web.json` clean.
3. `npm run dist -- --mac --arm64 --publish never` → `release/Next-Token-<ver>-arm64-mac.zip`.
4. Verify the zip (the gate script):
   - top-level `Next Token.app`, bundle id `com.nexttoken.app`
   - no `LSUIElement` in Info.plist
   - `Contents/Resources/sidecars/llama-server` is executable Mach-O arm64
   - zero `speechSynthesis` occurrences in source, dist, and zip
5. `npm run smoke` → 5/5 (headless Xvfb).
6. Copy the zip to `~/workspace/your_files/Next-Token-<ver>-mac.zip`,
   upload to Google Drive (anyone-with-link reader) for the manual-download path.
7. Upload the zip + `release/latest-mac.yml` to the R2 feed bucket.
8. Commit on `local-models`, verify the tree is clean.

## What the user experiences

- **No feed configured:** Settings → Updates says plainly that updates
  aren't set up; the app never checks anything.
- **Feed configured:** on launch (+30s) and every 12h the app checks
  `latest-mac.yml`. Newer version → the Updates page shows "Download
  update" with the size. Download shows progress + speed, verifies
  sha512, then offers "Restart to update".
- **Restart to update:** a detached script waits for quit, renames the
  old app to `Next Token.bak.app`, moves the new one in, runs
  `xattr -cr` automatically, relaunches, and removes the backup.
- **Can't write in place** (app in a read-only spot, no permission):
  the new app lands in Downloads, revealed in Finder, with three manual
  steps — never a silent failure.
- **Translocated copy:** the app explains to move it out of the
  translocated state first.

## Honest limitations (do not over-promise)

- The app is **unsigned**: no silent background updates like Chrome.
  One click to download + one click to restart is the ceiling until
  Developer ID signing + notarization exists.
- sha512 proves the bytes match the feed, not who published the feed.
  Feed security = HTTPS + whoever controls the R2 bucket.
- Differential updates are a future project; every update is a full
  ~340 MB zip until signing/delta infrastructure exists.
