// AI-writing check in the real side panel.
// Always: the fast tier renders an estimate for a reviewed page with zero network traffic.
// With E2E_DEEP=1: the worker downloads the pinned models (~400 MB, cached in .cache/detector/e2e-profile)
// and its numbers must match the Node training harness on the same text, so the trained weights
// apply to what users actually run.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const DEEP = !!process.env.E2E_DEEP;
const SAMPLE = `In today's rapidly evolving digital landscape, organizations must leverage cutting-edge solutions to remain competitive. Our comprehensive platform empowers teams to streamline workflows, foster collaboration, and unlock unprecedented growth.

Moreover, by harnessing the power of artificial intelligence, businesses can make data-driven decisions with confidence. This seamless integration ensures that every stakeholder remains aligned, informed, and engaged throughout the process.`;

let server, ctx, sw, panel, page, base, id;
const requests = [];

before(async () => {
  execSync('node build.mjs', { env: { ...process.env, E2E: '1' }, stdio: 'ignore' });
  server = http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync('test/fixtures/article.html')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const dist = path.join(tmpdir(), 'slopmachine-e2e');
  // Deep runs keep a profile so the model download (Cache Storage) survives between runs.
  ctx = await chromium.launchPersistentContext(DEEP ? '.cache/detector/e2e-profile' : '', {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  ctx.on('request', (r) => requests.push(r.url()));
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  id = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.scripting.registerContentScripts([{ id: 'e2e', matches: ['http://127.0.0.1/*'], js: ['content.js'], allFrames: true }]).catch(() => undefined));
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
  await panel.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings ?? {}), detection: 'fast' } });
  });
  [page] = await Promise.all([ctx.waitForEvent('page'), panel.evaluate((u) => chrome.tabs.create({ url: u }), `${base}/article`)]);
  await page.waitForLoadState();
});

after(async () => {
  await ctx?.close();
  server?.close();
});

test('fast tier: a reviewed page gets an estimate, reasons and a tier note, with no network', async () => {
  await panel.waitForFunction(() => document.getElementById('emptyAction')?.textContent === 'Review this page');
  await panel.click('#emptyAction');
  await panel.waitForFunction(() => document.getElementById('authorship')?.hidden === false);
  assert.match(await panel.textContent('#authNum'), /^\d{1,3}$/);
  assert.match(await panel.textContent('#authBand'), /Probably AI-written|Maybe AI-written|Can't tell|Probably written by a person/);
  // The bundled model ships in the package, so the fast tier needs no download.
  await panel.waitForFunction(() => /^Checked with the built-in model/.test(document.getElementById('authTier')?.textContent ?? ''), null, { timeout: 60_000 });
  assert.ok((await panel.locator('#authReasons li').count()) > 0);
  const external = requests.filter((u) => !u.startsWith(base) && !u.startsWith('chrome-extension://') && !u.startsWith('about:') && !u.startsWith('data:'));
  assert.deepEqual(external, []);
});

test('deep tier: browser worker matches the Node harness on the same text', { skip: !DEEP && 'set E2E_DEEP=1 (downloads ~400 MB once)' }, async () => {
  const browser = await panel.evaluate(async (text) => {
    const w = new Worker(chrome.runtime.getURL('detect-worker.js'), { type: 'module' });
    return new Promise((resolve, reject) => {
      w.onmessage = (e) => { if (e.data.type === 'result') resolve(e.data.evidence); if (e.data.type === 'error') reject(new Error(e.data.message)); };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ id: 1, tier: 'full', text });
    });
  }, SAMPLE);

  const { env } = await import('@huggingface/transformers');
  env.cacheDir = '.cache/detector/models';
  env.allowLocalModels = true;
  env.localModelPath = 'static/models/';
  const { DetectionModels } = await import('../../src/shared/detect/runner.ts');
  const { emptyStats, lmFeatures } = await import('../../src/shared/detect/lm.ts');
  const { normalizeForDetection } = await import('../../src/shared/detect/normalize.ts');
  const { chunkText, MAX_LM_CHUNKS } = await import('../../src/shared/detect/chunks.ts');
  const models = await DetectionModels.load('full');
  const norm = normalizeForDetection(SAMPLE).text;
  const stats = emptyStats();
  for (const c of chunkText(norm).slice(0, MAX_LM_CHUNKS)) await models.addLmStats(c.text, stats);
  const node = { ft: await models.bundled(norm), cls: await models.classify(norm), lm: lmFeatures(stats) };

  // WebAssembly and native int8 kernels round differently; the drift must stay far below what moves a verdict.
  assert.ok(Math.abs(browser.doc.cls - node.cls) < 0.25, `classifier ${browser.doc.cls} vs ${node.cls}`);
  assert.ok(Math.abs(browser.doc.ft - node.ft) < 0.25, `bundled ${browser.doc.ft} vs ${node.ft}`);
  const drift = Object.entries(node.lm).map(([k, v]) => ({ k, browser: browser.doc.lm[k], node: v, rel: Math.abs(browser.doc.lm[k] - v) / Math.max(1e-9, Math.abs(v)) }));
  if (process.env.E2E_VERBOSE) console.log(JSON.stringify({ cls: [browser.doc.cls, node.cls], drift }, null, 1));
  for (const d of drift) assert.ok(d.rel <= 0.03 || Math.abs(d.browser - d.node) <= 0.03, `${d.k}: ${d.browser} vs ${d.node}`);
});

test('deep tier: the panel switches to the full check and says so', { skip: !DEEP && 'set E2E_DEEP=1' }, async () => {
  await panel.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, detection: 'full' } });
  });
  // The settings change re-renders the panel, which queues the deep check for the current text.
  await panel.waitForFunction(() => /^Checked with all on-device models/.test(document.getElementById('authTier')?.textContent ?? ''), null, { timeout: 600_000 });
  assert.match(await panel.textContent('#authNum'), /^\d{1,3}$/);
});
