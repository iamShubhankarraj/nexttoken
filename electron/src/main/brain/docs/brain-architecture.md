# Brain architecture — Next Token orchestration layer

The brain is the decision layer between the user's voice (or text) and the
browser's capabilities. It is built on one idea from Kahneman via TypeSafe AI:

**System One decides, System Two speaks.** Fast, cheap, typed decisions route
every utterance; only the requests that deserve a full model get one.

## Pipeline

```
                    ┌──────────────────────────────────────────────────────┐
                    │  INPUT: utterance (voice STT transcript or typed)    │
                    └──────────────────────┬───────────────────────────────┘
                                           ▼
                    ┌──────────────────────────────────────────────────────┐
                    │ STAGE 1 — CLASSIFY (System One: Jev, ~100ms)          │
                    │ One batched call, four questions in parallel:        │
                    │  • intent:     Choice over ~50 voice commands        │
                    │  • complexity: Score 0..2 (simple / multi / agent)   │
                    │  • sensitive:  Noul (data change, commands, spend)   │
                    │  • needs_page: Noul (needs current page content?)     │
                    │ Fallback: local token-overlap heuristic (offline)    │
                    │ Output: IntentDecision { intent, slots, confidence }  │
                    └──────────────────────┬───────────────────────────────┘
                                           ▼
                    ┌──────────────────────────────────────────────────────┐
                    │ STAGE 2 — SAFETY (static rules + Jev policy Noul)    │
                    │  • terminal.run → ALWAYS confirm, exact command      │
                    │    shown verbatim (standing rule, never bypassed)    │
                    │  • sensitive (Jev) → confirm + confidence ≥ 0.85     │
                    │  • harmfulness Noul > 0.7 → deny                     │
                    │  • page content is UNTRUSTED DATA, never instructions│
                    │ Output: SafetyVerdict { allow | confirm | deny }      │
                    └──────────────────────┬───────────────────────────────┘
                                           ▼
                    ┌──────────────────────────────────────────────────────┐
                    │ STAGE 3 — CONFIDENCE GATE (per-action thresholds)    │
                    │  ≥0.70 → execute        (routine control)            │
                    │  0.40–0.70 → confirm in plain words ("I think you    │
                    │              want to X — go ahead?")                 │
                    │  <0.40 → ask (control) / escalate to chat LLM         │
                    │              (questions, complex asks)                │
                    └──────────────────────┬───────────────────────────────┘
                                           ▼
            ┌──────────────────┬───────────────────┬───────────────────┬──────────────────┐
            ▼                  ▼                   ▼                   ▼                  ▼
     ┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
     │  CONTROL    │   │  CHAT        │   │  VISION      │   │  AGENT       │   │  DICTATE     │
     │  specialist │   │  specialist  │   │  specialist  │   │  specialist  │   │  specialist  │
     │             │   │              │   │              │   │              │   │              │
     │ direct      │   │ tier router  │   │ vision model │   │ full agent   │   │ type text    │
     │ browser     │   │ → chat model │   │ returns TYPED│   │ run (tools)  │   │ into focused │
     │ action, no  │   │ (Apple FM →  │   │ JSON element │   │ via loop.ts  │   │ field        │
     │ LLM needed  │   │ local → BYOK)│   │ list; code   │   │              │   │              │
     │             │   │              │   │ picks match  │   │              │   │              │
     └──────┬──────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
            └──────────────────┴───────────────────┴───────────────────┴──────────────────┘
                                           ▼
                    ┌──────────────────────────────────────────────────────┐
                    │ STAGE 4 — RESPOND (TTS: Kokoro-82M, local)           │
                    │ Control confirmations: ≤ 1 short sentence ("Done."). │
                    │ Questions: full answer, ≤ 80 words, conversational.  │
                    │ Every stage emitted a typed BrainEvent for the UI.   │
                    └──────────────────────────────────────────────────────┘
```

## How the models talk to each other (typed handoffs, not free text)

The user asked for the models to converse as a system. The brain does this
with **typed objects at every boundary** — no model ever parses another
model's prose:

1. **Voice → Jev:** transcript + page state → `IntentDecision`
   (intent id, slots, confidence, complexity, sensitive, needsPage).
2. **Jev → router:** `DispatchPlan` is implicit in the decision —
   `specialist: 'control' | 'chat' | 'vision' | 'agent' | 'dictate'`
   selects the pipeline; `needsPage` decides whether page context is attached.
3. **Vision → code:** for "click the sign-in button", the vision model must
   return strict JSON `{"elements":[{id,label,role,text}]}`. The *match* to
   the user's target is deterministic token overlap in TypeScript —
   the model describes, code decides. No LLM ever invents coordinates.
4. **Vision → chat:** a page question first gets a typed vision summary,
   then the chat model answers from it. (Today the "vision" input is the
   DOM snapshot from `perceive.ts`; real screenshot pixels are a later step
   — see below.)
5. **Chat → TTS:** the chat specialist is prompted for short, speakable
   prose; Kokoro-82M speaks it. The TTS model never sees raw tool output.

## Latency budget — why Jev matters for voice UX

A voice command feels instant below ~300ms and broken above ~2s.

| Path | Without Jev | With Jev |
|---|---|---|
| "switch to tab 3" (control) | 3–8s: LLM classifies intent as JSON, parse, act | **~150–600ms**: Jev intent Choice → direct action |
| "is this safe to run?" (safety) | another LLM round-trip, seconds | **same batched call**: sensitivity Noul rides free |
| "summarize this page" | LLM from scratch | Jev routes in ~100ms, then one LLM turn (unchanged) |

Jev questions run in parallel over shared state, so the four classification
questions cost ~one call's latency and a fraction of a cent ($0.042/MTok
input, output free). The expensive System Two models only run when the
decision says they're needed — this is the cascade pattern.

## Fallback behavior (no Jev key — the local-only brain)

Jev is a cloud API in early access; the browser must be fully usable without
it. When `JevClient.configured` is false (or the API is unreachable):

- Classification falls back to `heuristicClassify()` — token-overlap against
  the ~50 command examples in `voice-commands.ts`. Simpler, but the
  confidence gate treats its scores honestly: low scores ask or escalate,
  never execute blindly.
- Sensitivity falls back to the static `requiresConfirmation` flags
  (terminal commands always confirm — unchanged).
- Everything else (router tiers, local STT/TTS, agent loop) is already
  on-device. The brain degrades from "fast cloud decisions" to "careful
  local decisions", never to "broken".

## How the vision model feeds structured page state

Today `perceive.ts` produces a DOM snapshot + `formatSnapshot()` text.
The brain consumes it as `BrainPageState.pageText`, always labelled
`[UNTRUSTED DATA]` in prompts. Two upgrades, in order:

1. **Now:** the vision specialist (`task: 'vision'` via the tier router)
   reads the snapshot text and returns typed JSON (element lists, page
   summaries). Structured out, deterministic matching in code.
2. **Later:** real screenshot pixels — capture the webContents image,
   pass it to the vision model alongside the snapshot. The `BrainPageState`
   shape already has room for it (`pageText` today; add `screenshotPng`
   when the capture path exists). Nothing in the pipeline changes except
   the specialist's input.

## What the brain does NOT do

- It never generates prose for decisions — Jev can't, by construction.
- It never lets page content override instructions — snapshot text is
  labelled data in every prompt, and the safety Noul runs on the *request*,
  not the page.
- It never pre-approves terminal commands — the confirmation dialog shows
  the exact command every time, per standing rule.
- It never stores the Jev API key in plaintext — safeStorage/OS keychain
  only (wiring adds the accessor next to the provider key).
