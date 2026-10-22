# Chrome Web Store submission: SlopMachine 0.1.0

Everything the developer dashboard asks for, in the order it asks. Upload `release/slopmachine-0.1.0.zip` (run `npm run build` first). Fill in the three placeholders before submitting: `[Publisher name]`, `[contact email]` and `[policy URL]`.

---

## Store listing tab

**Name** (from the manifest): SlopMachine

**Summary** (from the manifest `description`, 132 characters max; currently 109):
> A second read for what you write in the browser. Flags generic, unclear and AI-sounding text, on your device.

**Category:** Productivity › Tools. (Productivity › Communication also fits if you want to lead with email.)

**Language:** English

**Description:**

```
SlopMachine reads what you write in the browser and tells you what a careful editor would: the merge tag you forgot to fill, the phrase that could fit any company, the claim with nothing behind it, the sentence that sounds like a chatbot wrote it.

It works where you already write. Turn it on for Gmail, LinkedIn or any site you choose, click into a text box, and a score appears on the toolbar icon. Open the side panel to see why.

WHAT IT CHECKS
• Template leftovers: {{first_name}}, [Company], INSERT notes
• Stock phrases, with one-click swaps ("leverage" → "use", "serves as" → "is")
• Numbers without a source and vague asks ("Let's connect!")
• AI-writing habits, based on Wikipedia's "Signs of AI writing": "not X, but Y" contrasts, "Let that sink in" closers, staged run-ups, chatbot leftovers, "…, highlighting its importance" tails
• Rhythm: the same sentence opening three times, walls of text, dashes everywhere

It adapts to what you are writing: sales outreach, marketing copy, posts and articles, or documentation.

REVIEW PUBLISHED PAGES
On a help article or blog post, press "Review this page". You get the same checks, plus an optional page check that says whether the page is complete, understandable and natural-sounding, with the reasons.

FIX IT YOUR WAY
Every fix shows a preview first. Apply it with one click and undo it with Cmd/Ctrl+Z, or copy it instead. Nothing changes without your say.

OPTIONAL AI, ON YOUR TERMS
The rule-based review needs no AI and works offline. For rewrites and a deeper second opinion, pick an engine:
• Chrome's built-in AI, on your device
• A local model (Ollama, LM Studio)
• Your own OpenAI, Anthropic or Google Gemini key, with the model list loaded from your key

Before anything goes to a remote provider, SlopMachine shows exactly what will be sent and asks.

PRIVATE BY DESIGN
No account. No server. No analytics. Your text is never stored, and it only leaves your browser when you send it to the AI provider you chose. Keys stay in your browser.

SlopMachine is an editing aid, not an AI detector. It points at writing habits worth fixing; it never claims to know who wrote something.
```

**Graphics** (all in `store/assets/`, regenerate with `npm run store:assets`):

| Asset | File | Size |
| --- | --- | --- |
| Store icon | `icon-128.png` | 128×128 |
| Screenshot 1: draft review in a compose window | `screenshot-1-review.png` | 1280×800 |
| Screenshot 2: preview before applying fixes | `screenshot-2-preview.png` | 1280×800 |
| Screenshot 3: page check on a help article | `screenshot-3-page-check.png` | 1280×800 |
| Screenshot 4: choosing a rewrite engine | `screenshot-4-engines.png` | 1280×800 |
| Screenshot 5: dark theme | `screenshot-5-dark.png` | 1280×800 |
| Small promo tile | `promo-small-440x280.png` | 440×280 |
| Marquee promo tile (optional) | `promo-marquee-1400x560.png` | 1400×560 |

The screenshots show the real extension. The sites around it are neutral test pages (no real company branding), and AI results in screenshot 3 are example output from an intercepted provider.

**Official URL:** none (optional)
**Homepage URL:** [policy URL] or your project page
**Support URL:** [contact email] or an issues page

---

## Privacy practices tab

### Single purpose

```
SlopMachine reviews text the user writes in the browser, and pages the user chooses to review, for unclear, generic or AI-sounding writing, and helps the user fix it.
```

### Permission justifications

| Permission | Justification |
| --- | --- |
| `sidePanel` | The review, the fix previews and the settings shortcuts are shown in Chrome's side panel next to the page the user is writing on. |
| `storage` | Saves the user's settings (enabled sites, rules, phrase lists, chosen AI engine and model) in `chrome.storage.local`, and holds a session-only API key in `chrome.storage.session` so it is forgotten when Chrome closes. Draft text is never stored. |
| `scripting` | Registers the extension's own packaged content script only on sites the user turns on in Settings, and injects it into tabs of that site that are already open. No code is fetched from the network. |

**Host permissions.** All of these are optional and requested only when the user turns on the matching feature. The extension requests no host access at install time.

| Origin | Why |
| --- | --- |
| `https://mail.google.com/*` | Requested when the user turns on Gmail, so the content script can read the message box the user is typing in and apply fixes the user approves. |
| `https://*.linkedin.com/*` | Same, for LinkedIn messages and posts. |
| `https://*/*` | Used only for the "Other sites" setting: when the user adds a site (for example `https://*.example.com`), Chrome asks for that one site's pattern. The broad pattern is declared because Chrome requires every requestable origin to be listed in the manifest. The extension never asks for `https://*/*` itself. |
| `https://api.openai.com/*` | Requested when the user adds their own OpenAI key, to list the models that key can use and to send rewrite or review requests the user starts. |
| `https://api.anthropic.com/*` | Same, for the user's Anthropic key. |
| `https://generativelanguage.googleapis.com/*` | Same, for the user's Google Gemini key. |
| `http://localhost/*`, `http://127.0.0.1/*` | Requested when the user connects a local model server such as Ollama or LM Studio running on their own computer. |

### Remote code

```
No, I am not using remote code.
```
All JavaScript ships in the package, and the extension pages' CSP is `script-src 'self'; object-src 'self'`. Calls to AI providers send and receive data (text), not code.

### Data usage

**What user data do you plan to collect?** Check **Website content** only.

Explanation for reviewers, if asked:
> SlopMachine reads the text the user is typing (and, on request, the article on the current page) to review it in the browser. The publisher never receives it. If the user sets up an AI provider (on-device, local, or their own OpenAI, Anthropic or Gemini key), that text is sent directly from the browser to the provider the user chose, after a consent dialog unless the user turned the dialog off for that provider. API keys entered by the user are stored only in the browser and are sent only to the provider they belong to.

Leave unchecked: personally identifiable information, health information, financial and payment information, authentication information, personal communications, location, web history, user activity.

Reasoning for the boxes left unchecked:
- **Personal communications.** The extension reads the email or message the user is writing and, with the user's action, can pass it to the user's own AI provider. If the reviewer considers drafts to be personal communications, also check this box; the explanation above covers both. Checking it is the cautious choice.
- **Authentication information.** API keys are entered by the user for the user's own provider account, kept on the device, and never sent to the publisher. Check this box too if you prefer to disclose conservatively.

**Certifications.** All three can be certified truthfully:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

The transfer to an AI provider is an approved use case: it is user-initiated, goes only to the provider the user configured, and serves the item's single purpose.

**Privacy policy URL:** [policy URL]. Host `store/privacy-policy.html` there; GitHub Pages works.

---

## Distribution tab

- **Visibility:** Public (or Unlisted for a first round with your team)
- **Regions:** All regions
- **Pricing:** Free

---

## Notes for the reviewer

Paste into "Additional information for reviewers":

```
No account or login is needed. To test:
1. Install the extension and click its toolbar icon. The side panel opens.
2. Click the settings icon, then turn on Gmail under Sites (Chrome asks for mail.google.com access). Or under "Other sites", add any https site with a text box.
3. Open a compose window and type or paste a draft of 25+ words, for example one containing {{first_name}} and the phrase "in today's fast-paced world". A score appears on the toolbar icon, and the side panel lists issues with one-click fixes.
4. On any article on an enabled site, with no text box focused, press "Review this page" in the panel.
AI features are optional and off by default. They need the user's own on-device, local or API-key provider; the rule-based review works without any of them.
```
