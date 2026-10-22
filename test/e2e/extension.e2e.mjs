// Loads the unpacked extension in Chromium and drives a compose fixture:
// detection, local analysis, badge, revision-checked apply, native undo, lifecycle, no network.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const DIST = path.join(tmpdir(), 'slopmachine-e2e');
const DRAFT = 'Hi {{first_name}}, we leverage data to help teams. Our clients saw 43% more replies in a quarter. ' +
  'I wanted to share how reps at your company could write first emails that sound like them, not a template. Let me know.';

let server, ctx, sw, page, url;
const requests = [];

before(async () => {
  execSync('node build.mjs', { env: { ...process.env, E2E: '1' }, stdio: 'ignore' });
  const html = readFileSync('test/fixtures/compose.html');
  server = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
  ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  ctx.on('request', (r) => requests.push(r.url()));
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await sw.evaluate(() => chrome.scripting.registerContentScripts([
    { id: 'e2e', matches: ['http://127.0.0.1/*'], js: ['content.js'], runAt: 'document_idle' },
  ]));
  page = await ctx.newPage();
  await page.goto(url);
});

after(async () => {
  await ctx?.close();
  server?.close();
});

// Extension CSP forbids eval, so each helper is its own evaluate() body.
const send = (msg) => sw.evaluate(async (m) => {
  const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  return chrome.tabs.sendMessage(tab.id, m, { frameId: 0 });
}, msg);
const badge = () => sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  return chrome.action.getBadgeText({ tabId: tab.id });
});
const snapshot = () => send({ v: 1, type: 'snapshot/get' });
const settle = () => page.waitForTimeout(450);

test('textarea: local analysis, badge, apply, native undo', async () => {
  await page.click('#plain');
  await page.keyboard.insertText(DRAFT);
  await settle();
  const snap = await snapshot();
  assert.equal(snap.state, 'ready');
  assert.ok(snap.eligible);
  const ids = snap.analysis.issues.map((i) => i.ruleId);
  assert.ok(ids.includes('placeholder') && ids.includes('phrase') && ids.includes('numeric-claim'), ids.join());
  assert.equal(await badge(), String(snap.analysis.score));

  const fix = snap.analysis.issues.find((i) => i.ruleId === 'phrase').fix;
  const res = await send({ v: 1, type: 'apply', revision: snap.revision, start: fix.start, end: fix.end, replacement: fix.replacement });
  assert.equal(res.ok, true);
  assert.match(await page.inputValue('#plain'), /we use data/);

  await page.keyboard.press('ControlOrMeta+z');
  assert.match(await page.inputValue('#plain'), /we leverage data/, 'host undo reverts the apply');
});

test('placeholder issue clears after the user replaces it', async () => {
  await page.evaluate(() => {
    const t = document.querySelector('#plain');
    t.setSelectionRange(3, 17);
  });
  await page.keyboard.insertText('Alex');
  await settle();
  const snap = await snapshot();
  assert.ok(!snap.analysis.issues.some((i) => i.ruleId === 'placeholder'));
});

test('stale revision is rejected and nothing changes', async () => {
  const snap = await snapshot();
  await page.keyboard.insertText(' Thanks.');
  const before = await page.inputValue('#plain');
  const res = await send({ v: 1, type: 'apply', revision: snap.revision, start: 0, end: 2, replacement: 'Hey' });
  assert.deepEqual(res, { ok: false, reason: 'stale' });
  assert.equal(await page.inputValue('#plain'), before);
});

test('contenteditable: apply through the editing pipeline and undo', async () => {
  await page.click('#rich');
  await page.keyboard.insertText(DRAFT);
  await settle();
  const snap = await snapshot();
  assert.equal(snap.state, 'ready');
  const fix = snap.analysis.issues.find((i) => i.ruleId === 'phrase').fix;
  const res = await send({ v: 1, type: 'apply', revision: snap.revision, start: fix.start, end: fix.end, replacement: fix.replacement });
  assert.equal(res.ok, true);
  assert.match(await page.innerText('#rich'), /we use data/);
  await page.keyboard.press('ControlOrMeta+z');
  assert.match(await page.innerText('#rich'), /we leverage data/);
});

test('reveal selects the flagged text; dismiss removes the issue for this editor', async () => {
  const snap = await snapshot();
  const claim = snap.analysis.issues.find((i) => i.ruleId === 'numeric-claim');
  const res = await send({ v: 1, type: 'reveal', revision: snap.revision, start: claim.start, end: claim.end });
  assert.equal(res.ok, true);
  assert.equal(await page.evaluate(() => getSelection().toString()), '43%');

  await send({ v: 1, type: 'dismiss', key: claim.key });
  assert.ok(!(await snapshot()).analysis.issues.some((i) => i.key === claim.key));
});

test('short field clears the badge; password field is never read', async () => {
  await page.click('#subject');
  await page.keyboard.insertText('Quick question');
  await settle();
  assert.equal((await snapshot()).eligible, false);
  assert.equal(await badge(), '');

  await page.click('#pw');
  await page.keyboard.insertText('hunter2 hunter2');
  await page.waitForTimeout(500);
  assert.deepEqual(await snapshot(), { state: 'none' });
});

test('editor inside an iframe reports unsupported', async () => {
  await page.frameLocator('iframe').locator('#inner').click();
  await page.waitForTimeout(100);
  assert.deepEqual(await snapshot(), { state: 'unsupported', reason: 'iframe' });
});

test('no network requests beyond the page itself', () => {
  const external = requests.filter((u) => !u.startsWith(url) && !u.startsWith('chrome-extension://') && !u.startsWith('about:') && !u.startsWith('data:'));
  assert.deepEqual(external, []);
});

test('an editor that already has focus when the script starts is picked up', async () => {
  const fresh = await ctx.newPage();
  // Inject the script by hand into a page whose text box is focused before it loads.
  await fresh.goto(url.replace('127.0.0.1', 'localhost'));
  await fresh.click('#plain');
  await fresh.keyboard.insertText(DRAFT);
  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://localhost/*' });
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
  });
  await fresh.waitForTimeout(400);
  const snap = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://localhost/*' });
    return chrome.tabs.sendMessage(t.id, { v: 1, type: 'snapshot/get' }, { frameId: 0 });
  });
  assert.equal(snap.state, 'ready');
  await fresh.close();
});
