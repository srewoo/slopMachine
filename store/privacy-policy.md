# SlopMachine privacy policy

Effective October 22, 2026 · Applies to SlopMachine 0.1.0 and later

SlopMachine is a Chrome extension that reviews text you write in the browser, and pages you choose to review, and helps you edit it. It has no server, no account and no analytics. The publisher of SlopMachine, [Publisher name], never receives your text, your settings or your API keys.

## The short version

- Checking happens on your device. The rule-based review never leaves your browser.
- Your text goes to an AI provider only if you set one up, and only the provider you picked. Remote providers are asked about first, unless you told SlopMachine not to ask again for that provider.
- Your drafts and page text are never stored. They live in memory while you work and are gone when you move on.
- API keys stay in your browser. By default they are forgotten when Chrome closes.
- Nothing is sold, shared for advertising, or used for anything except the feature you are using.

## What SlopMachine reads

**The text box you are typing in**, on sites you turn on in Settings (Gmail, LinkedIn, or sites you add). It reads only the focused text box, never the rest of the page. In Gmail it leaves out the quoted thread and your signature. It never reads password fields, payment fields or text inside frames.

**A page you ask it to review.** When you press "Review this page", it reads the main article on that page (headings, paragraphs, lists, tables, link text and image descriptions). It skips navigation, headers, footers, sidebars, forms and hidden text. Nothing on a page is read until you press the button.

SlopMachine only runs on sites you have turned on. Chrome asks you to approve each one, and turning a site off removes the access.

## What stays on your device

| Data | Where it is kept | How long |
| --- | --- | --- |
| Text you are writing, page text, review results, AI findings | Memory only | Until you leave the text box, navigate away, switch tabs or close the panel |
| Settings: sites, rules, phrase lists, the kind of writing, rewrite engine, local endpoint address, chosen models, providers you trust | `chrome.storage.local` | Until you change them or press "Delete everything" in Settings |
| API keys, default | `chrome.storage.session` (not readable by web pages) | Until Chrome closes |
| API keys, if you choose "On this device" | The extension's own IndexedDB (not readable by web pages) | Until you remove them |

Keys saved "On this device" are not encrypted. Anyone with access to your Chrome profile could read them. SlopMachine recommends the default, which forgets keys when Chrome closes.

The toolbar badge shows your score for the current tab. SlopMachine does not keep a history of scores or texts.

## What leaves your device, and when

SlopMachine itself sends nothing anywhere. These are the only network requests it makes, and each goes **directly** from your browser to the service you configured:

1. **Rewrite, AI review and page check.** When you use these with a rewrite engine, SlopMachine sends:
   - the text you are writing, or for a page check an outline of the article and the page title;
   - the kind of writing you selected (for example "Documentation");
   - a short list of what the rule-based review already flagged;
   - instructions for the model.

   It does not send the page address, your cookies or other tabs. Where it goes depends on the engine you chose:
   - **Chrome built-in AI** runs on your device. Chrome may download Google's on-device model the first time; that download is between you and Chrome.
   - **A local model** (for example Ollama or LM Studio) receives the text at the localhost address you entered. It stays on your computer unless you have set that server up to forward it.
   - **OpenAI, Anthropic or Google Gemini, with your own API key.** The text goes straight to that company. A dialog shows the provider, endpoint, model, size and the exact text before anything is sent. You can tick "Don't ask again for this provider"; after that, AI reviews to that provider run automatically when you open the panel. You can turn asking back on in Settings at any time.
2. **Loading models.** When you press "Save key and load models", SlopMachine asks that provider which models your key can use. This request contains your key and no text.
3. **Testing a local endpoint.** When you press "Allow access and test", SlopMachine asks your local server for its model list. It sends no text.

Requests are made once per action and are never retried automatically. Anthropic requests are made with Anthropic's official client library, which adds technical headers such as the library version and browser type. Your API key travels in the request header to the provider. Chrome's developer tools can show it, like any request your browser makes.

What a provider does with the text is governed by your agreement with them:
- OpenAI: https://openai.com/policies/privacy-policy
- Anthropic: https://www.anthropic.com/legal/privacy
- Google: https://policies.google.com/privacy

## What SlopMachine does not do

- No analytics, tracking pixels, crash reporting or advertising.
- No code downloaded from the internet. Everything runs from the installed package.
- No selling, renting or sharing of your data.
- No use of your data to decide credit, lending or employment, or for any purpose other than the review and editing features described here.
- No reading of sites you have not turned on.

SlopMachine's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Your controls

In SlopMachine's Settings you can:

- turn sites on or off, which also grants or removes Chrome's access;
- pick or remove a rewrite engine, and forget a key and the provider's access;
- turn off "Run the AI review when I open the panel", and turn "Ask before each send" back on for any provider;
- export your settings as a file (it never contains keys or text), import them, forget session data, or delete everything.

Removing the extension from Chrome deletes all of its stored data.

## Children

SlopMachine is a writing tool for work and is not directed at children under 13.

## Changes

If this policy changes, the new version is published at [policy URL] with a new effective date. A change that affects what leaves your device is also described in the extension's release notes.

## Contact

Questions about this policy: [contact email]
