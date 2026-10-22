// BYOK end to end, with every provider API intercepted (no real keys, no real traffic):
// model lists load per key, the picker fills dynamically, and each rewrite request carries
// the right auth headers and the right temperature/thinking settings for its model.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const DRAFT = 'Hi Sam, we leverage data to help teams write better first emails. Our clients saw 43% more replies in a quarter. ' +
  'I wanted to share how your reps could sound like themselves instead of a template. Let me know if you are interested.';

const MODELS = {
  openai: { data: [{ id: 'gpt-4o', created: 1 }, { id: 'o3', created: 3 }, { id: 'text-embedding-3-small', created: 5 }, { id: 'gpt-5.2', created: 4 }] },
  anthropic: {
    data: [
      { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', max_tokens: 128000, max_input_tokens: 1000000,
        capabilities: { thinking: { supported: true }, effort: { supported: true, low: { supported: true } }, structured_outputs: { supported: true } } },
      { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', max_tokens: 64000, max_input_tokens: 200000,
        capabilities: { thinking: { supported: true }, effort: { supported: false, low: { supported: false } } } },
    ],
    has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-4-5',
  },
  google: {
    models: [
      { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'], outputTokenLimit: 65536, thinking: true },
      { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'], outputTokenLimit: 8192 },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  },
};

const REWRITTEN = 'Hi Sam, your reps could sound like themselves in first emails. Could I show you how on Thursday?';
const COMPLETIONS = {
  openai: { model: 'gpt-5.2', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: REWRITTEN } }] },
  anthropic: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: REWRITTEN }], usage: { input_tokens: 10, output_tokens: 10 },
  },
  google: { modelVersion: 'gemini-3.5-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'plan', thought: true }, { text: REWRITTEN }] } }] },
};

const LABELS = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' };
// The AI review answers with JSON findings; the quote is copied from DRAFT.
const REVIEW = JSON.stringify({
  overall: 'Friendly, but the benefit is vague.',
  findings: [{ quote: 'write better first emails', severity: 'warning', title: 'Say what "better" means', why: 'The reader cannot picture the result.', suggestion: 'write first emails that get replies' }],
});
const REVIEW_REPLY = {
  openai: { model: 'gpt-5.2', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: REVIEW } }] },
  anthropic: { ...COMPLETIONS.anthropic, content: [{ type: 'text', text: REVIEW }] },
  google: { modelVersion: 'gemini-3.5-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: REVIEW }] } }] },
};
const isReview = (body) => /Review v\d|Page check v\d/.test(JSON.stringify(body ?? ''));
const isPageCheck = (body) => JSON.stringify(body ?? '').includes('Page check v');
const PAGE_CHECK = JSON.stringify({
  verdicts: {
    complete: { rating: 'partly', reason: 'It never says when the change happens.' },
    understandable: { rating: 'good', reason: 'The table makes the change easy to follow.' },
    voice: { rating: 'partly', reason: 'The opening uses a stock phrase.' },
  },
  overall: 'Useful, but readers will ask when.',
  findings: [{ quote: 'After the change, admins will', severity: 'warning', title: 'Say when the change happens', why: 'Readers need a date to plan.', suggestion: '' }],
});

const ORIGINS = { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com', google: 'https://generativelanguage.googleapis.com' };

let server, ctx, sw, id, page, panel, opts;
const calls = [];

before(async () => {
  execSync('node build.mjs', { env: { ...process.env, E2E: '1' }, stdio: 'ignore' });
  server = http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' })
    .end(readFileSync(`test/fixtures/${q.url?.startsWith('/article') ? 'article' : 'compose'}.html`)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dist = path.join(tmpdir(), 'slopmachine-e2e');
  ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  for (const [vendor, origin] of Object.entries(ORIGINS)) {
    await ctx.route(`${origin}/**`, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const body = req.postDataJSON();
      calls.push({ vendor, method: req.method(), url: req.url(), headers: await req.allHeaders(), body, review: isReview(body) });
      const json = req.method() === 'GET' ? MODELS[vendor]
        : isPageCheck(body) ? { ...COMPLETIONS.anthropic, content: [{ type: 'text', text: PAGE_CHECK }] }
        : isReview(body) ? REVIEW_REPLY[vendor] : COMPLETIONS[vendor];
      if (isReview(body)) await new Promise((r) => setTimeout(r, 800)); // long enough to see "in progress"
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(json) });
    });
  }
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  id = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.scripting.registerContentScripts([{ id: 'e2e', matches: ['http://127.0.0.1/*'], js: ['content.js'] }]));

  opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${id}/options/index.html`);
  await opts.check('input[name="provider"][value="byok"]');
});

after(async () => {
  await ctx?.close();
  server?.close();
});

async function loadModels(vendor, key) {
  await opts.check(`input[name="vendor"][value="${vendor}"]`);
  await opts.locator('#keyLabel', { hasText: LABELS[vendor] }).waitFor();
  await opts.fill('#byokKey', key);
  await opts.click('#byokLoad');
  await opts.locator('#byokResult', { hasText: 'Key works' }).waitFor();
  return opts.locator('#byokModel option').allTextContents();
}

test('model picker fills from each key, newest first, text models only', async () => {
  assert.deepEqual(await loadModels('openai', 'sk-test-openai'), ['gpt-5.2 · thinking', 'o3 · thinking', 'gpt-4o']);
  assert.match(await opts.textContent('#modelNote'), /temperature is left at OpenAI's default.*reasoning effort is set to low/);

  assert.deepEqual(await loadModels('anthropic', 'sk-ant-test'), ['Claude Opus 5.5 · thinking', 'Claude Haiku 4.5 · thinking']);
  assert.match(await opts.textContent('#modelNote'), /No temperature is sent.*Effort is set to low/);

  assert.deepEqual(await loadModels('google', 'AIza-test'), ['Gemini 3.5 Flash · thinking', 'Gemini 2.0 Flash']);
  await opts.locator('#modelNote', { hasText: 'thinking is set to low' }).waitFor();

  await opts.selectOption('#byokModel', 'gemini-2.0-flash');
  await opts.locator('#modelNote', { hasText: 'Temperature 0.4' }).waitFor();
  await opts.selectOption('#byokModel', 'gemini-3.5-flash');
  await opts.locator('#modelNote', { hasText: 'thinking is set to low' }).waitFor();
});

test('model listing sends each provider its own auth header and no draft', () => {
  const lists = Object.fromEntries(calls.filter((c) => c.method === 'GET').map((c) => [c.vendor, c]));
  assert.equal(lists.openai.headers.authorization, 'Bearer sk-test-openai');
  // SDK 1.x sends API keys as a bearer token.
  assert.equal(lists.anthropic.headers.authorization, 'Bearer sk-ant-test');
  assert.equal(lists.anthropic.headers['anthropic-version'], '2026-10-21');
  assert.equal(lists.anthropic.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(lists.google.headers['x-goog-api-key'], 'AIza-test');
  assert.ok(!lists.google.url.includes('AIza-test'), 'Gemini key goes in a header, not the URL');
});

test('key field is cleared after saving and never shown again', async () => {
  assert.equal(await opts.inputValue('#byokKey'), '');
  assert.ok(!(await opts.textContent('body')).includes('AIza-test'));
});

async function openPanelOnDraft() {
  // Real Chrome has one side panel per window; close the previous one so only one follows the tab.
  await panel?.close();
  await page?.close();
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
  // Open the draft tab from the panel's own window, the way the real side panel sits beside its tab.
  [page] = await Promise.all([
    ctx.waitForEvent('page'),
    panel.evaluate((u) => chrome.tabs.create({ url: u }), `http://127.0.0.1:${server.address().port}/`),
  ]);
  await page.waitForLoadState();
  await page.click('#plain');
  await page.keyboard.insertText(DRAFT);
  await panel.locator('#rewriteBtn:not([disabled])').waitFor();
}

async function rewriteWith(vendor) {
  await opts.check(`input[name="vendor"][value="${vendor}"]`);
  await panel.locator('#engineName', { hasText: { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' }[vendor] }).waitFor();
  const before = calls.length;
  await panel.click('#rewriteBtn');
  await panel.locator('#consent[open]').waitFor();
  assert.equal(calls.length, before, 'nothing is sent while the consent dialog is open');
  await panel.click('#consentSend');
  await panel.locator('#proposal:not([hidden])').waitFor();
  const post = calls.slice(before).find((c) => c.method === 'POST');
  await panel.click('#discardBtn');
  return post;
}

test('cancelling the consent dialog sends nothing', async () => {
  await openPanelOnDraft();
  await opts.check('input[name="vendor"][value="anthropic"]');
  await panel.locator('#engineName', { hasText: 'Anthropic' }).waitFor();
  const before = calls.length;
  await panel.click('#rewriteBtn');
  await panel.locator('#consent[open]').waitFor();
  await panel.click('#consent button[value="cancel"]');
  await panel.locator('#rewriteStatus', { hasText: 'Nothing was sent' }).waitFor();
  assert.equal(calls.length, before);
});

test('OpenAI reasoning model: no temperature, low reasoning effort, max_completion_tokens', async () => {
  const { body, headers } = await rewriteWith('openai');
  assert.equal(headers.authorization, 'Bearer sk-test-openai');
  assert.equal(body.model, 'gpt-5.2');
  assert.equal(body.reasoning_effort, 'low');
  assert.ok(!('temperature' in body) && !('max_tokens' in body));
  assert.ok(body.messages[1].content.includes('we leverage data'), 'the draft is in the request');
});

test('Anthropic: no sampling params, low effort, refusal fallback, proposal names the model', async () => {
  const { body, headers } = await rewriteWith('anthropic');
  assert.equal(body.model, 'claude-opus-5-5');
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body), k);
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.fallbacks, 'default');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(headers['x-stainless-retry-count'] ?? '0', '0');
});

test('Gemini 3: thinkingLevel low, no temperature, thought parts excluded from the text', async () => {
  const { body } = await rewriteWith('google');
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.ok(!('temperature' in body.generationConfig));
  await panel.click('#rewriteBtn');
  await panel.locator('#consent[open]').waitFor();
  await panel.click('#consentSend');
  await panel.locator('#proposal:not([hidden])').waitFor();
  assert.ok(!(await panel.textContent('#diff')).includes('plan'), 'thought summaries never reach the proposal');
  assert.match(await panel.textContent('#proposalSource'), /Gemini 3\.5 Flash via Google Gemini/);
});

const aiText = () => panel.evaluate(() => document.getElementById('aiText')?.textContent ?? '');
const waitAi = (text) => panel.waitForFunction((t) => document.getElementById('aiText')?.textContent?.includes(t), text);

test('hybrid: rules show at once; an unapproved provider waits for a click before anything is sent', async () => {
  await opts.check('input[name="vendor"][value="openai"]');
  await openPanelOnDraft();
  assert.ok(await panel.evaluate(() => document.querySelectorAll('#issues .issue').length > 0), 'rule-based results are already listed');
  await waitAi('AI review sends this draft to OpenAI');
  assert.equal(calls.filter((c) => c.review).length, 0, 'nothing is sent on open without consent');

  await panel.click('#aiAction');
  await panel.locator('#consent[open]').waitFor();
  assert.match(await panel.textContent('#consentBody'), /for an AI review/);
  await panel.click('#consentSend');
  await waitAi('AI review in progress');
  await waitAi('1 more thing to look at');
  const review = calls.find((c) => c.review && c.vendor === 'openai');
  assert.deepEqual(review.body.response_format, { type: 'json_object' });
});

test('hybrid: AI findings are clubbed into the list, tagged AI, unscored, with a verdict', async () => {
  if (process.env.SHOT) await panel.screenshot({ path: process.env.SHOT, fullPage: true }); // optional visual check
  const ai = panel.locator('.issue', { has: panel.locator('.tag-ai') });
  assert.equal(await ai.count(), 1);
  const row = await ai.textContent();
  assert.match(row, /Say what "better" means/);
  assert.match(row, /not scored/);
  assert.match(await panel.textContent('#aiOverall'), /benefit is vague/);
  await ai.getByRole('button', { name: 'Use suggestion' }).click();
  await panel.waitForFunction(() => document.getElementById('proposal')?.hidden === false);
  assert.match(await panel.textContent('#proposalSource'), /Suggested by the AI review/);
  await panel.click('#discardBtn');
});

test('hybrid: "Don\'t ask again" makes the next open run the AI review by itself', async () => {
  await opts.check('input[name="vendor"][value="anthropic"]');
  await openPanelOnDraft();
  await waitAi('AI review sends this draft to Anthropic');
  await panel.click('#aiAction');
  await panel.locator('#consent[open]').waitFor();
  await panel.check('#consentRemember');
  await panel.click('#consentSend');
  await waitAi('1 more thing to look at');
  const first = calls.filter((c) => c.review && c.vendor === 'anthropic');
  assert.equal(first.at(-1).body.output_config.format.type, 'json_schema', 'structured outputs where the model supports them');
  await opts.waitForFunction(() => !document.querySelector('#askEachSend').checked); // settings reflect the trust

  await openPanelOnDraft(); // a fresh panel open: no click this time
  await waitAi('AI review in progress');
  await waitAi('1 more thing to look at');
  assert.equal(calls.filter((c) => c.review && c.vendor === 'anthropic').length, first.length + 1);
  assert.ok(!(await aiText()).includes('sends this draft'));
});

test('page check: outline goes to the provider, three verdicts come back next to the rule results', async () => {
  await opts.check('input[name="vendor"][value="anthropic"]'); // trusted in the previous test: runs by itself
  await panel?.close();
  await page?.close();
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
  [page] = await Promise.all([ctx.waitForEvent('page'), panel.evaluate((u) => chrome.tabs.create({ url: u }), `http://127.0.0.1:${server.address().port}/article`)]);
  await page.waitForLoadState();
  await panel.waitForFunction(() => document.getElementById('emptyAction')?.textContent === 'Review this page');
  await panel.click('#emptyAction');
  await waitAi('Page check in progress');
  await waitAi('Page check by');

  const sent = calls.findLast((c) => isPageCheck(c.body));
  const user = sent.body.messages[0].content;
  assert.match(user, /# Coming soon: a separate module type/);
  assert.match(user, /\| Workflow \| Today \|/);
  assert.ok(!user.includes('NAVMARKER') && !user.includes('FOOTERMARKER'));
  assert.deepEqual(sent.body.output_config.format.schema.required, ['verdicts', 'overall', 'findings']);
  assert.match(sent.body.system, /Never claim or guess who or what wrote the page/);

  const verdicts = await panel.evaluate(() => [...document.querySelectorAll('#verdicts .verdict')].map((v) => `${v.dataset.rating}|${v.textContent}`));
  assert.deepEqual(verdicts, [
    'partly|Complete?Partly complete It never says when the change happens.',
    'good|Understandable?Clear The table makes the change easy to follow.',
    'partly|Natural voice?Some AI-style habits The opening uses a stock phrase.',
  ]);
  const ai = panel.locator('.issue', { has: panel.locator('.tag-ai') });
  assert.match(await ai.textContent(), /Say when the change happens/);
  if (process.env.SHOT) await panel.screenshot({ path: process.env.SHOT.replace('.png', '-page.png'), fullPage: true });
});
