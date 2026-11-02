// PDFs and Google Docs: the panel downloads and reads them itself, read-only, and forgets them with the tab.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const PDF_LINES = [
  ['Here is what nobody tells you about onboarding: the first week decides', 700],
  ['retention. The agent reads mail. The assistant drafts replies. The tool', 686],
  ['sends them. Plot twist: none of it needs a meeting. We utilize a checklist', 672],
  ['in order to keep every new hire on track during that first week at work.', 658],
];
/** Minimal one-page PDF (same shape as test/document.test.ts). */
function makePdf(lines) {
  const stream = lines.map(([t, y]) => `BT /F1 11 Tf 72 ${y} Td (${t}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PDF = makePdf(PDF_LINES);
const DOC_TEXT = '﻿Launch plan\r\n\r\nThe best part: it learns from every edit. What if I told you setup takes ten minutes? Think about it: no meetings, no tickets, and the team ships on Tuesday as planned.\r\n';

let ctx, sw, panel, id;
const requests = [];
const panelReady = () => panel.waitForFunction(() => document.getElementById('ready')?.hidden === false);
const rules = () => panel.$$eval('#issues [data-rule], #issues li', (els) => els.map((e) => e.textContent ?? '').join('\n'));
const openTab = async (url) => {
  const [p] = await Promise.all([ctx.waitForEvent('page'), panel.evaluate((u) => chrome.tabs.create({ url: u }), url)]);
  await p.waitForLoadState();
  return p;
};

before(async () => {
  execSync('node build.mjs', { env: { ...process.env, E2E: '1' }, stdio: 'ignore' });
  const dist = path.join(tmpdir(), 'slopmachine-e2e');
  ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  ctx.on('request', (r) => requests.push(r.url()));
  await ctx.route('https://files.example/**', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF }));
  await ctx.route('https://docs.google.com/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === `/document/d/${DOC_ID}/export`) return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: DOC_TEXT });
    if (u.pathname.includes('/export')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in</html>' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><canvas></canvas></body></html>' });
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  id = new URL(sw.url()).host;
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
});

after(async () => {
  await ctx?.close();
});

test('a Google Doc tab offers a review and reads it through the export, read-only', async () => {
  await openTab(`https://docs.google.com/document/d/${DOC_ID}/edit`);
  await panel.waitForFunction(() => document.getElementById('emptyAction')?.textContent === 'Review this Google Doc');
  await panel.click('#emptyAction');
  await panelReady();
  assert.match(await panel.textContent('#context'), /docs\.google\.com · Google Doc/);
  const text = await rules();
  for (const t of ['colon reveal', 'rhetorical setup']) assert.match(text.toLowerCase(), new RegExp(t.split(' ')[0]), t);
  assert.equal(await panel.isHidden('#applyBtn') || await panel.isDisabled('#applyBtn'), true, 'never Apply on a document');
  assert.ok(requests.some((u) => u.endsWith(`/document/d/${DOC_ID}/export?format=txt`)));
});

test('a Doc the account cannot open says so instead of reviewing a sign-in page', async () => {
  await openTab('https://docs.google.com/document/d/9ZzZzZzZzZzZzZzZzZzZzZzZzZzZzZ/edit');
  await panel.waitForFunction(() => document.getElementById('emptyAction')?.textContent === 'Review this Google Doc');
  await panel.click('#emptyAction');
  await panel.waitForFunction(() => document.getElementById('emptyTitle')?.textContent === 'Couldn’t read the document');
  assert.match(await panel.textContent('#emptyBody'), /signed in/);
});

test('a PDF tab is downloaded and parsed by the packaged pdf.js worker', async () => {
  await openTab('https://files.example/onboarding.pdf');
  await panel.waitForFunction(() => document.getElementById('emptyAction')?.textContent === 'Review this PDF');
  await panel.click('#emptyAction');
  await panelReady();
  assert.match(await panel.textContent('#context'), /files\.example · 1 page/);
  const text = (await rules()).toLowerCase();
  assert.match(text, /nobody tells you/, 'faux-insight found in PDF text');
  assert.match(text, /utilize|in order to/, 'stock phrase found in PDF text');
});

test('switching tabs drops the document', async () => {
  await openTab('about:blank');
  await panel.waitForFunction(() => document.getElementById('ready')?.hidden === true);
  assert.equal(await panel.textContent('#context'), '');
});

test('a chosen PDF file is read on the device with no request at all', async () => {
  await panel.waitForFunction(() => [...document.querySelectorAll('#emptyMore button')].some((b) => b.textContent === 'Choose a PDF file'));
  const before = requests.length;
  await panel.setInputFiles('#pdfFile', { name: 'notes.pdf', mimeType: 'application/pdf', buffer: PDF });
  await panelReady();
  assert.match(await panel.textContent('#context'), /notes\.pdf · 1 page/);
  assert.deepEqual(requests.slice(before).filter((u) => !u.startsWith('chrome-extension://')), []);
});

test('a file that is not a PDF is refused with a reason', async () => {
  await openTab('about:blank');
  await panel.waitForFunction(() => document.getElementById('ready')?.hidden === true);
  await panel.setInputFiles('#pdfFile', { name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html>nope</html>') });
  await panel.waitForFunction(() => document.getElementById('emptyBody')?.textContent === 'This is not a PDF file.');
});
