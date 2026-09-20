# Jev API — research findings (2026-09-21)

Jev is TypeSafe AI's "System One" decision model (launched Sep 15, 2026, $40M seed led by DCVC, built by Diogo Almeida, co-inventor of RLHF/InstructGPT).
It does not generate text. You send **state** + typed **questions**; it returns typed, calibrated probabilistic decisions in one parallel pass.

Sources: dev.to practical guide (valyuai), jev-agent.com (independent, cites official docs), everydev.ai, vedcraft.com, foundermag.co, github.com/kraayenjon/awesome-jev.

## Endpoint

- **Official:** `POST https://api.typesafe.ai/v1/systemone`
- **Auth:** `Authorization: Bearer <TYPESAFE_API_KEY>`
- Other access routes (same model, different billing):
  - Vercel AI Gateway, model id `typesafe-ai/jev` (no waitlist)
  - Cloudflare Workers AI, model id `typesafe/jev`
  - Early access direct: waitlist at typesafe.ai, keys at `console.typesafe.ai/settings/keys`
- SDKs: `pip install typesafe-sdk` (Python 3.10+) and `npm install @typesafe-ai/sdk` (Node 20+). Both read `TYPESAFE_API_KEY` from env and default to model `jev-latest`.
- We call the official endpoint directly with `fetch` (no SDK dependency) — see `src/main/brain/jev.ts`.

## Request shape (verified from SDK examples + proxy "official shape")

```json
{
  "state": "Charged twice for September and cancelling Friday unless refunded.",
  "questions": {
    "queue": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": "Payments and refunds", "technical": "Bugs and outages" }
    },
    "severity": {
      "type": "score",
      "instructions": "How urgent is this?",
      "criteria": ["Low", "Normal", "High", "Urgent"]
    },
    "churn": {
      "type": "noul",
      "instructions": "Threatening to cancel?",
      "criteria": { "true": "Mentions cancelling", "false": "No cancellation intent" }
    }
  },
  "model": "jev-latest"
}
```

Rules:
- `state`: string, JSON object, or array of strings. **Text only** — no image/audio/video at launch.
- `model` is optional; known routes: `jev-latest`, `jev-preview`, `jev-1.13.0`.
- Choice: up to **255 options**. Each option costs a few tokens. Always include an explicit `other` option so the model can say nothing fits.
- Score: 2–10 ordered levels, described in words; index comes from array order.
- Context: 64k tokens for state + all questions together; 32k for state + single longest question.
- Questions run **in parallel over the same state** — a tenth question costs tokens but almost no time. Batch everything up front (speculative fan-out).

## The three primitives and their answers

| Primitive | Asks | Returns |
|---|---|---|
| `Choice` | pick one option from a set | `.choice` (option key) · `.probabilities` (per option) · `.confidence` |
| `Score` | grade on an ordered rubric | `.score` (probability-weighted mean of level **indices**, e.g. `2.48` on a 4-level rubric — can land *between* levels) · `.legend` (index→label) · `.probabilities` (keyed by index **as strings**: `"0"`, `"1"`) · `.confidence` |
| `Noul` | yes/no as a probability | `.noul` (0–1 float) — **no `confidence` field** (not null, absent). Distance from 0.5 is the belief. |

Example response (from jev-agent's systemone proxy, stated to be the official shape):

```json
{
  "answers": {
    "queue":      { "type": "choice", "choice": "billing", "confidence": 1 },
    "severity":   { "type": "score", "score": 2.48, "legend": {"0":"Low","3":"Urgent"} },
    "churn_risk": { "type": "noul", "noul": 0.97 }
  }
}
```

Our client (`jev.ts`) parses defensively: it accepts `answers` at the top level, at `data.answers`, or at `results[0].answers` (proxy classify shape), and tolerates missing optional fields.

Error conventions (from the proxy; official errors are the same HTTP codes): `400` malformed body (message names the field — note: sending `kind` instead of `type` lands here), `401` bad/missing key, `429` rate-limited, `502` upstream refused/timed out, `503` API unavailable. Every error is `{"error": "…"}`.

## Pricing & latency (vendor-reported, unreproduced by third parties)

- $0.042 per 1M **input** tokens; output free (no output tokens are generated).
- 70–500ms end-to-end (TypeSafe claims 40–200× faster than frontier LLMs on classification work).
- RLCD training (Reinforcement Learning for Calibrated Decisions): confidence is meaningful in aggregate — higher confidence ≈ higher accuracy. This is what makes per-action confidence thresholds sound.

## Patterns we use in the brain (`orchestrator.ts`)

1. **Speculative fan-out** — intent Choice + complexity Score + sensitivity Noul + needs-page Noul in one call.
2. **Confidence-gated routing** — one threshold per action cost: read-only control ≥0.5, destructive/sensitive ≥0.85 **plus** user confirmation, <0.4 → ask/escalate.
3. **The cascade** — Jev decides; the chat/vision LLM writes. Jev never replaces prose.

## What I could NOT verify

- The official raw HTTP response envelope from `api.typesafe.ai` itself (I read the official shape via the SDK examples and the jev-agent proxy docs, which states it returns the official shape). `jev.ts` parses defensively, but validate with a real key before shipping.
- Whether Vercel AI Gateway exposes the same `systemone` JSON shape (gateways often re-shape). Our client takes a configurable `baseUrl`, so a gateway can be tried — but treat the shape as unverified there.
- Performance numbers are TypeSafe's own, self-run and unreproduced — fine for architecture, not for marketing claims.
