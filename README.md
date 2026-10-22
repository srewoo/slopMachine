# SlopMachine

A Manifest V3 Chrome extension that reviews what you write in the browser (sales outreach, marketing copy, posts and articles, documentation) before it goes out. It flags template leftovers, stock phrasing, unsupported claims and flat rhythm locally, shows a 0–100 **Draft Quality Risk** score in the toolbar badge, and offers fixes you preview before applying. No backend. See [`prd.md`](prd.md).

## Run it

```sh
npm install
npm run build          # → dist/ and release/slopmachine-<version>.zip
```

The version comes from `package.json` only: bump it there (`npm version patch --no-git-tag-version`) and the build stamps it into `dist/manifest.json` and the zip name. Chrome accepts 1–4 dot-separated integers, so a semver prerelease like `1.0.0-beta.1` fails the build. Upload `release/slopmachine-<version>.zip` to the Chrome Web Store dashboard. The zip is reproducible (sorted entries, fixed timestamps) and is never produced by `--watch` or `E2E=1` builds.

Open `chrome://extensions`, turn on Developer mode, **Load unpacked** → `dist/`. Click the toolbar icon to open the side panel, then **Settings → Sites** to turn on Gmail or LinkedIn. Chrome asks for that one site's permission.

| Command | What it does |
| --- | --- |
| `npm run check` | typecheck + unit tests + build |
| `npm test` | rule engine, diff, sanitize, prompt, settings and message-schema tests (`node:test`, native TS) |
| `npm run e2e` | loads the unpacked extension in Chromium: detection, badge, apply, native undo, stale revision, password/iframe exclusion, zero network; plus BYOK against intercepted OpenAI/Anthropic/Gemini APIs (model lists, auth headers, consent, temperature/thinking per model). Test builds go to the system temp folder, never `dist/` |
| `npm run store:assets` | regenerates Chrome Web Store graphics in `store/assets/` (5 screenshots, promo tiles, icon) from the real extension, and `store/privacy-policy.html` from `store/privacy-policy.md`. Listing copy, permission justifications and data-use answers are in `store/listing.md` |
| `node scripts/screens.mjs <dir>` | screenshots the real side panel (light, dark, proposal) and options page |

`npm run e2e` needs Playwright's Chromium once: `npx playwright install chromium`.

## How it fits together

```
content script ──analysis/updated (score only, no text)──▶ service worker ──▶ badge for sender tab
      ▲                                              └──────────────▶ side panel (re-fetches)
      └── snapshot/get · apply · reveal · dismiss ◀── side panel ──▶ model (only on Rewrite)
```

- **Content script** (`src/content`): finds the focused editor via a site adapter, extracts plain text with an offset→DOM map, runs the rule engine on a 200 ms debounce, owns the revision token. Applies edits through `execCommand('insertText')` so the host's own Cmd/Ctrl+Z works, verifies the result and rolls back if the host rejected it.
- **Service worker** (`src/sw`): badge/title per tab, and reconciles dynamically registered content scripts against granted permissions on install, startup and permission changes.
- **Side panel** (`src/sidepanel`): pulls a fresh snapshot, renders issues, builds local or model proposals bound to a revision, shows the diff, applies or copies.
- **Shared** (`src/shared`): pure rule engine, zod message schemas, settings, diff, sanitizer, prompt, providers.

## Decisions taken from the architecture and design reviews

| PRD conflict | Ruling |
| --- | --- |
| §13.1 `self.ai.languageModel` vs §7 `LanguageModel` | `LanguageModel.availability()` / `create()`; session is created synchronously in the click handler so a first download gets user activation |
| §13.2 Ollama `/api/generate` | One OpenAI-compatible client (`/v1/chat/completions`) for Ollama and LM Studio |
| §13.3 remote providers | Bring your own key for **OpenAI, Anthropic and Google Gemini**, each an exact manifest origin. The model list is fetched with the user's key; see *Rewrite engines* below |
| §8 "focus loss clears the badge" | Focus moving to another element in the page clears it. The **window** losing focus does not, because clicking into the side panel would otherwise wipe the draft being reviewed |
| §12 dark "tactical HUD", webfonts, emoji, "LLM markers" copy | Dropped: conflicts with §6 (no remote assets), §8 (light + dark) and §1 (not an AI detector). Calm editorial palette, system fonts, severity as words |
| §12 Apply on Cmd+Enter | Dropped: Cmd+Enter sends in Gmail |
| API key lifetime | `chrome.storage.session` by default (unreachable from content scripts); `storage.local` only after an explicit, warned opt-in |
| Remote consent | Confirmed **every** request; "remember for this provider" deferred |
| §5.1 "never scan the page" vs reviewing published docs and articles | Only on request: on an enabled site, **Review this page** reads the main content (article/main, skipping nav, header, footer, sidebars, forms and hidden text). Read-only: fixes and rewrites are Copy only, "Show on page" just selects text, and navigating away ends the review |
| One kind of writing | A **Reviewing as** choice (sales outreach, marketing copy, posts and articles, documentation) changes which rules apply and how the rewrite is briefed |
| §5.4 "shorten a selected passage" without a model | Deferred: no deterministic way to do it well |
| Streaming output | Not streamed; diff and Apply appear only after the full response is sanitized |

## Capability matrix

| Adapter | Detect | Analyze | Highlight (select) | Full/selection apply | Native undo | Copy fallback |
| --- | --- | --- | --- | --- | --- | --- |
| Generic `<textarea>` / text `<input>` | ✓ | ✓ | ✓ | ✓ | ✓ (E2E) | ✓ |
| Generic `contenteditable` | ✓ | ✓ | ✓ | ✓ verified, rolled back on mismatch | ✓ (E2E) | ✓ |
| Gmail compose | ✓ | ✓ quoted thread + signature excluded | ✓ | ✓ | needs manual check on live Gmail | ✓ |
| LinkedIn message/post | ✓ | ✓ | ✓ | ✓ | needs manual check on live LinkedIn | ✓ |
| Editors inside iframes | reports "not supported yet" | ✗ | ✗ | ✗ | ✗ | ✗ |

Outlook Web, HubSpot, Salesforce, Slack, Google Docs and CMS adapters are Phase 3.

## AI-writing patterns

The rules include the 26 patterns from [blader/humanizer](https://github.com/blader/humanizer) (MIT, see `THIRD_PARTY_NOTICES.md`), built on Wikipedia's *Signs of AI writing*:

- **Deterministic:** §1–5 staged phrasing ("not X but Y", closers, deep-sounding sayings, run-ups, arguing with no one), §6–10 and §19–20 rhythm and formatting, §12–18 inflation, sales language and borrowed authority, §22–23 chatbot leftovers and knowledge-limit disclaimers, §25 writing about the document. Humanizer's strength rule is kept: patterns it calls *weak alone* (dashes, hedges, threes, hyphen pairs, vague links) only count when other tells are present or they repeat. Quoted text is never flagged, and sales emails keep normal asks like "Would you like me to send the deck?".
- **AI only** (need judgment): §11 passive voice hiding the actor, §24 a heading restated in its first line, §26 re-explaining what the reader already knows. These, and paragraph-scale versions of the others, are what the AI review is told to look for.
- **Skipped:** §21 curly quotes. Most editors curl quotes automatically, so it is mostly noise.
- **Rewrite** follows humanizer's method silently: mark the tells, draft, check for added or dropped facts and surviving tells, return the final text. No em dashes in prose.

## Hybrid review

1. **Rules first, instantly.** The deterministic engine scores the draft on this device. The score is always theirs: explainable, repeatable, offline.
2. **Then the AI review**, through the engine picked in Settings, looking only for what rules can't see (unclear sentences, risky claims, tone, missing context). The panel shows "AI review in progress…" with Cancel.
3. **Clubbed results.** AI findings join the same list sorted by severity, tagged **AI**, marked "not scored", with an optional suggestion that goes through the normal preview → Apply/Copy. Repeats of rule findings are dropped; a finding whose quoted text you change disappears; the model's output is validated (`src/shared/review.ts`) and quotes it invented are ignored.

It runs by itself when the panel opens (once per open, tab switch or page review) only if no new consent is needed: Chrome's on-device model when already downloaded, a local model, or a remote provider the user ticked "Don't ask again" for. Otherwise the panel offers **Run AI review**, and a remote send shows the consent dialog. Settings: *Run the AI review when I open the panel*, and per provider *Ask before each send*.

### Page check

When you press **Review this page**, the AI pass becomes a page check. It gets a structured outline of the article only (headings with levels, lists, table rows, link text, image alt text and code; no navigation, sidebars, footers, forms or hidden text), up to 40,000 characters (12,000 for Chrome's on-device model, which has a small context window). It returns three verdicts, each rated in words with a reason:

- **Complete?** Does the page deliver what its title promises (steps, prerequisites, limits, dates, who is affected, a next action)?
- **Understandable?** Can the intended reader follow it?
- **Natural voice?** Does it read like a careful person wrote it, judged only on writing habits it can quote. It never says or guesses who wrote the page.

Findings behind the verdicts join the list like any AI finding. The consent dialog shows the exact outline and its size before a remote provider gets it.

## Rewrite engines

| Engine | Model list | Thinking / temperature handling |
| --- | --- | --- |
| Chrome built-in AI | n/a | on-device, Chrome's defaults |
| Local (Ollama, LM Studio) | typed by the user | `temperature 0.4` |
| OpenAI (your key) | `GET /v1/models`, chat models only | reasoning models (o-series, GPT-5+): no `temperature`, `reasoning_effort: "low"`, `max_completion_tokens`; others `temperature 0.4` |
| Anthropic (your key) | `GET /v1/models` via the official SDK, with per-model capabilities | never sends `temperature`/`top_p`/`top_k` (rejected on API version `2026-10-21`); `effort: "low"` only where the model advertises it; refusal fallback (`fallbacks: "default"`) on Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5.5; SDK retries off |
| Google Gemini (your key) | `GET /v1beta/models`, `generateContent` text models | Gemini 3+: no temperature, `thinkingLevel: "low"`; 2.5 thinking: `thinkingBudget: 1024`; others `temperature 0.4`; thought parts are never shown |

Keys are per provider, held until Chrome closes unless the user opts to keep them. Every send shows a consent dialog naming the provider, endpoint, model and character count; Cancel sends nothing. The settings page explains each model's tuning in plain words, generated from the same request builders the extension uses. Tones: Direct, Concise, Conversational, Professional.

## Local model setup

- **Ollama:** `OLLAMA_ORIGINS=chrome-extension://<extension id> ollama serve` (the id is shown in Settings). Endpoint `http://localhost:11434/v1`.
- **LM Studio:** enable CORS in the server settings. Endpoint `http://localhost:1234/v1`.

The connection test only requests `/models`; it never sends a draft.
