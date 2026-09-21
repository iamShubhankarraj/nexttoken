# Dia Browser — UI/UX Research Reference

Research compiled 2026-09-21 for the Next Token browser project.
Goal: a concrete, rebuildable description of Dia's interface, AI features, and visual language.
Sources listed at the end. Anything marked [inferred] is a reasonable read from descriptions, not a verified spec.

---

## 1. Product overview

- **Dia** is The Browser Company's AI-first browser (successor in focus to Arc; Arc is in maintenance mode).
- Built on **Chromium** (Blink + V8); deliberately looks and feels like Chrome/Safari — "a more polished Chrome", "even more minimalist than Comet" (Thurrott).
- macOS-only (Apple silicon, macOS 14+). No Windows date announced (waitlist exists).
- Core thesis: **the address bar is a command bar** — one input for navigation, search, and AI prompts, with intent-based routing. Plus a **persistent right-side AI chat sidebar** and an **inline writing cursor**.
- Pricing: Free tier (core features, capped AI chat) · **Dia Pro $20/mo** (unlimited chat) · **Better Days $100/mo** (6× tasks/chats, daily Morning Brief, reports/decks/recaps, meeting prep). Plans page frames tiers as "Better Browser / Better Answers / Better Days".

---

## 2. Window layout & chrome

- **Top bar (Chrome-like):** horizontal tab strip across the top, omnibox/command bar centered, standard window controls. Familiar on purpose — near-zero learning curve for Chrome users.
- **Vertical tabs:** added in a later update (brought back from Arc after user demand). Optional mode.
- **Spaces:** Arc-style workspaces rolling out (Early Bird program, mid-2026) — sidebar-organized workspaces with separate tab groups, recognizable Arc layout.
- **Right sidebar = AI chat panel:** a large chat window docked on the **right side** of every window. Open on demand, closable; described as "huge chat window on the right". Comparable to Edge's Copilot sidebar, but central to the product rather than an add-on.
- **Profiles & tab groups, split-view, picture-in-picture video** are listed as built-in (Plans page: Free tier).
- **Split View:** up to **3 tabs in one view**, then ask Chat to "connect the dots" across them (official site).
- **New tab behavior:** clicking the **new tab button opens a large centered bar** — the chatbot/command-bar UI doubling as search + address bar + AI entry point (gHacks). [inferred: Cmd/Ctrl+T equivalent focuses this bar rather than a traditional new-tab page with tiles.]
- **Settings:** minimal; reviewers say settings "kind of resemble Safari" and there are "barely any settings to tweak". Deliberately un-geeky.
- **Extensions:** importable from Chrome; access/UX still maturing per reviewers.
- **Built-in ad & tracker blocker**, on by default (toggleable). "Block ads, pop-ups, and trackers, before they ever reach you."

---

## 3. The command bar (AI address bar)

This is Dia's signature interaction — the single most important thing to replicate.

- The omnibox handles **three input types**: site navigation, search queries, **AI prompts**.
- **Intent routing:** Dia decides whether to send input to Google or to its AI, "mostly based on the length and the syntax of the request" (molodtsov.me). Short navigational text → Google; longer natural-language → AI.
- **User override:** you can always manually choose Google vs. AI for any query — the routing is a default, not a lock-in.
- **Natural-language commands in the bar** (from the launch demo, CEO Josh Miller):
  - "What was that doc that Cyrus sent me about Heidegger" → Dia resurfaces the exact Notion doc from a Slack chat via Memory, even though the user forgot the name.
  - Then: "email it to [coworker]" → Dia composes/sends via the user's preferred email client, **pulling in open Amazon tabs with short descriptions** automatically.
  - Then: "create a calendar event instead" — chained follow-ups in the same bar.
- **Tab mentions:** type **@** in the bar/chat to @-mention any open tab (e.g. @ghacks) and pull it in as context — for comparison, summarization, or tab management. Works with **files/attachments** too.
- **Agentic demos (prototype stage):** "auto-browsing" — e.g. adding items from an email list to an Amazon cart by browsing Amazon itself; sending personalized emails to people in a Notion table. Shipped product is more conservative: chat + skills + actions, not full autonomy.

**Rebuild notes:**
- One input, three modes, smart default + visible manual toggle (Search | Ask AI).
- @-autocomplete for tabs (show favicon + title), files, and history items.
- Follow-up chaining: after an answer, keep context so the next command ("email it to X") resolves pronouns.

---

## 4. Chat sidebar — "Ask Dia"

- **Invocation:** **Cmd+E** opens Chat docked on the side (right). Also reachable from the command bar and per-tab.
- **Context model:** Chat always knows the **current tab's content**. @-mentions add more tabs; opt-in **History (up to 7 days)** adds browsing history; attachments add files.
- **What it does:**
  - Summarize the current page ("summarize this", "pull the key talking points").
  - Compare across @-mentioned tabs (products, papers, hotels, jobs) — "present a comparative outlook".
  - Ask about **selected text**.
  - Web search on demand ("ask it to search the web for you").
  - Extract structured data from messy pages ("extract data from complex HTML layouts and get a simple list of bullet points").
  - Shopping: "is this actually good?", promo-code hunting, review synthesis from Reddit/top review sites.
  - Video: **timestamped key moments** for long YouTube videos.
  - Draft/write: emails, posts, rewrites without leaving the page.
- **Follow-ups:** answers end with offered **"links" to adjacent topics** — suggested follow-up questions to dig deeper.
- **Ephemeral by design:** Dia keeps only a **few recent chats in history**; chats are low-friction and disposable, unlike ChatGPT's hoarding. Reviewers call this out as a reason they use it constantly.
- **Tone:** notably **not sycophantic**; straightforward answers, especially after personalization.
- **Example real prompts cited by reviewers:**
  - "Summarise the article in Tab 1 and compare it to the report I saved yesterday."
  - "I want a modern-looking men's shirt with a blue and white horizontal striped pattern." → scours the web, presents organized results (stops short of purchasing).
  - "Find me a modern men's shirt with blue and white horizontal stripes."
  - "pull the key talking points" / "summarize what has happened" (on a long paper/story).
  - Multi-article: open a dozen articles on AI coding → "summarize them into a quick single industry report" (makeshift NotebookLM).

---

## 5. Skills

- **Definition:** reusable, saved prompts = "your reusable AI shortcuts". If you repeat a prompt, save it as a Skill and trigger it **in one click / via shortcut**.
- **Built-in skill categories** (per coverage): writing & rewriting, summarizing, coding, brainstorming, social media drafting; also comparing prices, summarizing news, drafting emails, fact-checking, productivity planning.
- **Custom skills:** create your own in **Skills Gallery → "Create Skill"**; invoke saved skills via **shortcuts**.
- **Skills Gallery:** public gallery (v0.1 launched July 2025), organized by **category**; remix by **copying the prompt** into your own library.
- **Slash-command style examples** from the community gallery (caneraras.com):
  - `/summarize` — "Read this page and provide: 3 main takeaways in bullet points; key statistics; most important quote; why this matters (1 sentence). Keep it under 100 words."
  - `/twitterthread` — convert page into 5–7 tweet thread with hook, one point per tweet, CTA, emojis, hashtags.
  - `/instagramcaption` — hook + 3–4 lines + emojis + 8–12 hashtags.
  - `/competitor [company-name]` — one-sentence what-they-do, value prop, audience, strengths/weaknesses, one learning.
  - `/trends` — 3 emerging patterns, drivers, implications, one 6-month prediction.
  - `/email [purpose]` — subject line, concise opening, 2–3 points from page content, closing with next steps.
  - `/summarize-for-lit-review` — extract claims, counter-arguments, citations across @-mentioned papers.

**Rebuild notes:** Skills = named prompt templates with a keyboard shortcut each + a gallery UI (cards by category, one-click "add"). Slash-invocation inside chat.

---

## 6. Writing help (insertion cursor + everywhere-text)

Two layers:

1. **Insertion-cursor assistant** (signature demo): click the **blinking text cursor** in any text field → a **popup menu** appears with next-step suggestions:
   - Complete the sentence you're writing.
   - Fetch facts from the web mid-sentence (demo: writing about the original iPhone launch → pulls specs live).
   - Pull browser context into the draft (demo: "paste all of the Amazon links I have open" → inserts links **with short descriptions**).
2. **Built-in spelling & grammar checker in every text field** — always on, no extension needed.

**Rebuild notes:** the cursor popup is the differentiator — a small contextual menu anchored to the caret with 2–4 actions (complete, fetch fact, insert tab links, change tone). Keep it instant and dismissible.

---

## 7. Memory & personalization ("Personal Intelligence")

- **Memory:** opt-in; keeps **summaries** (not raw content) of your activity so "yesterday's work is still open today". Powers: resuming work, the Heidegger-doc recall demo, personalized answers.
- **Privacy controls on the marketing site, shown as explicit toggles:**
  - Block trackers — **On**
  - Personalize new chats — **Off** (default)
  - Memory — **On**
  - Block ads — **On**
  - Share content data — **Off**
- Sensitive sites and incognito are excluded from Memory by default; per-site opt-out available. Data: history/bookmarks/files/chats **encrypted and stored locally**; only minimal data leaves the device per AI request; partners restricted from training/storing; chat data deleted after 30 days (per onboarding copy).
- **Personalization:** tell Dia your preferences in plain language — e.g. "here are writers I like, I prefer outlines and bullet points" — and answers adapt (structure, tone, brevity). This is positioned as a first-class setup step, not buried settings.
- **Onboarding:** pick an **accent color** for the browser → Personal Intelligence intro → import (bookmarks, passwords, history, extensions — from Chrome/Brave/Opera/Vivaldi/Edge; Safari "coming soon"; no Firefox) → ad/tracker blocking pre-checked → default-browser prompt.

---

## 8. Morning Brief & higher tiers

- **Morning Brief** (Pro $100 "Better Days" tier): a daily brief built from your tabs, calendar, and work context. Homepage shows it with a playful countdown ("in 11 0m").
- $100 tier also: 6× more tasks/chats, create reports/decks/recaps, meeting prep & follow-up.
- $20 tier: "Ask Dia anything on any page", "Chat with context from all your tools", "models that won't store your data".

---

## 9. Visual language

**Browser chrome (from reviewer descriptions):**
- Deliberately **familiar/minimal** — "feels like a more polished Chrome", "even more minimalist than Comet". Light, clean, lots of whitespace; no Arc-style radical chrome.
- **Right-side chat panel** is the main visual differentiator in-window; large, conversational, closable.
- **Accent color is user-pickable** at onboarding — the chrome takes on a personal tint.
- Copy tone is playful and confident: "A browser you won't dread opening", "Features so good, they feel illegal", "Built for how you actually work".

**Marketing site (diabrowser.com) — verified via a design teardown:**
- Electric blue `#3139FB` as the dominant stage color, warm cream `#FFFCEA` / off-white `#FFFCEC`, red `#FB3A4D` as a sticker-like accent. No gradients-as-identity; flat, poster-like.
- Typography: **Marlin Soft SQ** (friendly, storybook headline weight, −0.04em tracking) · **InterVariable** (body/product labels) · **ABC Favorit Mono** (small labels).
- Scalloped / paper-cut divider edges — tactile, handmade-at-the-boundary feel.

[Note: exact corner radii, spacing scale, and in-product dark-mode treatment were not verifiable from text sources — screenshot analysis would be needed. The in-product aesthetic reads as light-first, Chrome-adjacent minimalism.]

---

## 10. Invocation cheatsheet (keyboard & entry points)

| Action | How |
|---|---|
| Open AI chat sidebar | **Cmd+E** |
| Ask / navigate / command | Type in the **command bar** (omnibox); Dia routes to Google vs AI by length/syntax; manual override available |
| Pull a tab into context | **@ + tab name** (autocomplete with favicon + title) |
| New tab → AI entry | New-tab button opens the **large centered command/chat bar** |
| Run a saved Skill | Skill's **keyboard shortcut** or one-click in chat/gallery |
| Writing help at caret | **Click the insertion cursor** → popup menu (complete sentence, fetch fact, insert open-tab links) |
| Spelling/grammar | Automatic in **every text field** |
| Compare tabs | @-mention 2–3 tabs in chat, or open in **Split View** (≤3 tabs) and ask |
| Reference history | Opt-in **7-day History** as chat context |

---

## 11. What reviewers say is best-in-class (the parts to steal)

1. **The command bar as the whole product** — one input, smart routing, @-mentions, chained follow-ups. "The browser's address bar can not only dig contextual information for you, it can also take actions on your behalf."
2. **Tab-aware chat with @-mentions** — "Tab intelligence is the best feature of Dia" (Digital Trends). Multi-tab compare in one breath.
3. **Ephemeral, low-friction chat** — no chat-history hoarding; you use it 50×/day because each ask costs nothing mentally.
4. **Insertion-cursor writing popup** — AI exactly where the caret is, with live web facts and tab-link insertion.
5. **Skills as one-click saved prompts + public gallery** — turns repeat work into shortcuts.
6. **Personalization in plain language** — "write like these people, use outlines" beats a settings page.
7. **Every-text-field grammar** — invisible, everywhere.
8. **Explicit privacy toggles as UI** — Block trackers / Memory / Share content data shown as plain On/Off switches in marketing and (implied) settings.

## 12. Known weaknesses (avoid repeating)

- Extension UX immature vs Chrome; settings sparse ("barely any settings to tweak") — power users bounce.
- macOS-only; no Windows date.
- Free-tier AI caps push toward $20/mo.
- AI answers "not as refined as standalone frontier models" (Seraphic); phishing detection ~46% ≈ Chrome — insufficient for autonomous agents doing transactions (LayerX).
- Early agentic demos (auto-buying, auto-emailing) were prototypes; shipped product is chat+skills, not reliable autonomy.

---

## Sources

- Official site: https://www.diabrowser.com/ (homepage: "A browser you won't dread opening"; privacy toggles; Morning Brief)
- Official: https://www.diabrowser.com/students (Memory, Mention Tabs, Split View, Command Bar, Ad Block)
- Official: https://www.diabrowser.com/plans (Better Browser / Better Answers $20 / Better Days $100 tiers)
- Yury Molodtsov, "I Can't Stop Using Dia Browser" — https://molodtsov.me/2025/08/i-cant-stop-using-dia-browser/ (Cmd+E, omnibox routing, personalization, ephemeral chats, vertical tabs)
- Knowlab overview — https://knowlab.in/dia-the-ai-browser-youll-actually-use-what-it-is-how-it-works-and-whether-it-beats-chrome-arc/ (features, pricing, privacy, use cases)
- gHacks, "Dia Browser beta launched with AI features" — https://www.ghacks.net/2025/06/12/dia-browser-beta-launched-with-ai-features/ (onboarding, right chat window, new-tab command bar, @-mentions)
- TechCrunch, "Dia launches a skill gallery" — https://techcrunch.com/2025/07/21/dia-launches-a-skill-gallery-perplexity-to-add-tasks-to-comet/ (Skills, gallery v0.1)
- Caner Aras community Skills gallery — https://www.caneraras.com/learn/browser-skills-gallery (slash-command skill examples)
- TechRadar on the Dia teaser demos — https://www.techradar.com/computing/browsers/dia-a-new-web-browser-from-makers-of-the-arc-browser-is-taking-aim-at-google-chrome-with-clever-ai-features (insertion cursor popup, command-bar actions, auto-browsing)
- allthings.how on the announcement demos — https://allthings.how/the-browser-company-is-building-another-ai-browser-dia/ (Memory/Heidegger demo, ADK components: Memory, LLMs, Action, Self-Driving)
- Digital Trends on browser subscriptions — https://www.digitaltrends.com/computing/browser-subscriptions-are-here-and-its-the-only-one-i-dont-regret-paying-for/ (AI sidebar, tab intelligence, @ shortcut)
- ZDNet — https://Www.Zdnet.Com/article/free-ai-powered-dia-browser-now-available-to-all-mac-users-windows-users-can-join-a-waitlist/ (sidebar, spelling/grammar in every text box, example prompts)
- Wikipedia, "Dia (web browser)" — https://en.wikipedia.org/wiki/Dia_(web_browser) (Chromium base, disabled Google data-collection features, 7-day History, Seraphic/LayerX findings)
- Thurrott.com (premium) — https://www.thurrott.com/a-i/324493/what-dia-says-about-the-ai-powered-future-of-web-browsing (minimalism vs Comet, Spaces plans)
- piunikaweb on Spaces rollout — https://piunikaweb.com/2026/07/30/dia-browser-spaces-early-bird-users/ (Early Bird Spaces)
- Design teardown of the Dia-era Arc marketing (palette/type) — https://github.com/fivetaku/insane-design/blob/HEAD/docs/reports/arc/design.md
