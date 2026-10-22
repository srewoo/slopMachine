// Page review: only on request, main content only, read-only (Copy, never Apply), cleared on navigation.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

let server, ctx, sw, panel, page, base;
const snapshot = () => sw.evaluate(async () => {
  const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  return chrome.tabs.sendMessage(t.id, { v: 1, type: 'snapshot/get' }, { frameId: 0 });
});
const panelReady = () => panel.waitForFunction(() => document.getElementById('ready')?.hidden === false);

before(async () => {
  execSync('node build.mjs', { env: { ...process.env, E2E: '1' }, stdio: 'ignore' });
  server = http.createServer((q, r) => {
    const file = q.url?.startsWith('/article') ? 'article.html' : 'compose.html';
    r.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(`test/fixtures/${file}`));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dist = path.join(tmpdir(), 'slopmachine-e2e');
  ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const id = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.scripting.registerContentScripts([{ id: 'e2e', matches: ['http://127.0.0.1/*'], js: ['content.js'] }]));
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
  [page] = await Promise.all([ctx.waitForEvent('page'), panel.evaluate((u) => chrome.tabs.create({ url: u }), `${base}/article`)]);
  await page.waitForLoadState();
});

after(async () => {
  await ctx?.close();
  server?.close();
});

test('nothing is read until the user asks', async () => {
  await panel.waitForFunction(() => document.getElementById('emptyAction')?.textContent === 'Review this page');
  assert.deepEqual(await snapshot(), { state: 'none' });
});

test('review reads the article only: no nav, header, sidebar, footer or hidden text', async () => {
  await panel.click('#emptyAction');
  await panelReady();
  const snap = await snapshot();
  assert.equal(snap.mode, 'page');
  assert.equal(snap.canApply, false);
  for (const m of ['NAVMARKER', 'HEADERMARKER', 'ASIDEMARKER', 'FOOTERMARKER', 'HIDDENMARKER', 'CSSHIDDENMARKER']) assert.ok(!snap.text.includes(m), m);
  assert.match(snap.text, /Workflow Today/, 'table cells stay separate words');
  const rules = snap.analysis.issues.map((i) => i.ruleId);
  assert.ok(rules.includes('placeholder') && rules.includes('phrase'), rules.join());
  assert.match(await panel.textContent('#context'), /127\.0\.0\.1 · page/);
});

test('the AI page check gets a structured outline of the article only', async () => {
  const snap = await snapshot();
  const r = await sw.evaluate(async (rev) => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    return chrome.tabs.sendMessage(t.id, { v: 1, type: 'page/outline', revision: rev, max: 40000 }, { frameId: 0 });
  }, snap.revision);
  assert.equal(r.ok, true);
  assert.match(r.outline, /^Page title: Article fixture/);
  assert.match(r.outline, /^# Coming soon: a separate module type$/m);
  assert.match(r.outline, /^\| Workflow \| Today \|$/m);
  assert.match(r.outline, /^\| Create \| Admins create it as a Mission\. \|$/m);
  for (const m of ['NAVMARKER', 'ASIDEMARKER', 'FOOTERMARKER', 'HIDDENMARKER', 'CSSHIDDENMARKER']) assert.ok(!r.outline.includes(m), m);
  const stale = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    return chrome.tabs.sendMessage(t.id, { v: 1, type: 'page/outline', revision: 'old', max: 40000 }, { frameId: 0 });
  });
  assert.deepEqual(stale, { ok: false }, 'an outdated revision gets nothing');
});

test('show on page selects the flagged text without changing it', async () => {
  const before = await page.textContent('article');
  const hit = panel.locator('.snippet').first();
  assert.match(await hit.getAttribute('title'), /Show on page/);
  await hit.click();
  await page.waitForFunction(() => getSelection().toString().length > 0);
  assert.equal(await page.evaluate(() => getSelection().toString()), '[Your CSM]');
  assert.equal(await page.textContent('article'), before);
});

test('fixes on a page are copy-only', async () => {
  await panel.getByRole('button', { name: /^Cut it|^Use / }).first().click();
  await panel.waitForFunction(() => document.getElementById('proposal')?.hidden === false);
  assert.equal(await panel.evaluate(() => document.getElementById('applyBtn').hidden), true);
  assert.equal(await panel.evaluate(() => document.getElementById('copyBtn').classList.contains('btn-primary')), true);
  assert.deepEqual(
    await sw.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      return chrome.tabs.sendMessage(t.id, { v: 1, type: 'apply', revision: 'x', start: 0, end: 1, replacement: 'y' }, { frameId: 0 });
    }),
    { ok: false, reason: 'unsupported' },
    'the content script refuses edits to a reviewed page',
  );
});

test('navigating away ends the review', async () => {
  await page.goto(`${base}/other`);
  await panel.waitForFunction(() => document.getElementById('ready')?.hidden === true);
  assert.deepEqual(await snapshot(), { state: 'none' });
});
