# Third-party notices

## Flow — dictation pipeline (MIT)

Portions of Next Token's voice dictation pipeline — the rule-based
"quick clean" transcript cleanup, the `<think>`-block stripper, the
vocabulary guard for LLM formatter output, the silence-peak guard, and
the dictation post-processor system prompt + few-shot examples in
`electron/resources/prompts/dictation-system.txt` and
`electron/resources/prompts/dictation-few-shot.json` — are adapted from
**Flow** by Jose Gabriel Vilchez, licensed under the MIT License.

- Source: https://github.com/jgvilchezc/flow
- License: MIT License, Copyright (c) 2026 Jose Gabriel Vilchez

```
MIT License

Copyright (c) 2026 Jose Gabriel Vilchez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ghostery Adblocker — ad-blocking engine (MPL-2.0)

Next Token's native ad blocker (`electron/src/main/adblock/`) is built on
**@ghostery/adblocker-electron** (which bundles **@ghostery/adblocker**),
by Ghostery GmbH, licensed under the Mozilla Public License 2.0.

- Source: https://github.com/ghostery/adblocker
- License: https://mozilla.org/MPL/2.0/ (Copyright (c) 2017-present Ghostery GmbH)

The engine loads community filter lists at runtime (EasyList and uBlock
Origin filters, mirrored via Ghostery's CDN); those lists carry their own
licenses/attribution:

- EasyList — https://easylist.to/ (attribution to the EasyList authors)
- uBlock Origin filters (uAssets) — https://github.com/uBlockOrigin/uAssets

## electron-updater — in-app update plumbing (MIT)

Update scaffolding (`electron/src/main/updater.ts`) uses **electron-updater**
by electron-userland, licensed under the MIT License.

- Source: https://github.com/electron-userland/electron-builder (packages/electron-updater)
- License: MIT (Copyright (c) 2015-2019 electron-userland)

## bplist-parser — Safari bookmark import (MIT)

Safari bookmark import (`electron/src/main/import/bookmarks.ts`) parses
`Bookmarks.plist` (binary plist) with **bplist-parser** by Joe Ferner,
licensed under the MIT License.

- Source: https://github.com/joeferner/node-bplist-parser
- License: MIT (Copyright (c) 2012 Joe Ferner)
