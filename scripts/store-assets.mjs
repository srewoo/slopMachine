// Chrome Web Store graphics from the real extension, plus the hostable privacy policy page.
// Usage: npm run store:assets  → store/assets/*.png and store/privacy-policy.html
// AI results are example output from an intercepted provider; no real key or request is used.
import { execSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';

const OUT = 'store/assets';
const PAGE_W = 900;
const PANEL_W = 380;
const H = 800;

const DRAFT = `Hi {{first_name}},

I hope this email finds you well. In today's fast-paced world, sales teams need more than tools. Our platform serves as a testament to what modern teams can do, helping reps leverage data to unlock exponential growth.

Our customers have seen 43% more replies in their first quarter. Let that sink in.

Would love to hop on a quick call next week. Let's connect!

Best,
Jordan`;

const reply = (text) => ({
  id: 'msg_store', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: JSON.stringify(text) }], usage: { input_tokens: 1, output_tokens: 1 },
});
const DRAFT_REVIEW = reply({
  overall: 'Friendly, but Priya learns nothing about her own team from it.',
  findings: [{ quote: 'sales teams need more than tools', severity: 'warning', title: 'Say what you actually do for her team', why: 'After the first paragraph the reader still does not know what you sell.', suggestion: '' }],
});
const PAGE_CHECK = reply({
  verdicts: {
    complete: { rating: 'partly', reason: 'It never says when the move happens or who loses access.' },
    understandable: { rating: 'good', reason: 'The before-and-after table makes the change easy to follow.' },
    voice: { rating: 'partly', reason: 'The opening leans on a stock phrase and a "not X, but Y" line.' },
  },
  overall: 'Clear about what changes, silent about when.',
  findings: [{ quote: 'Your existing drafts move automatically', severity: 'warning', title: 'Say when drafts move', why: 'Admins need a date to warn their teams.', suggestion: '' }],
});

async function composite(ctx, pagePng, panelPng, file) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: PAGE_W + PANEL_W, height: H });
  const src = (b) => `data:image/png;base64,${b.toString('base64')}`;
  await p.setContent(`<body style="margin:0;position:relative;width:${PAGE_W + PANEL_W}px;height:${H}px;overflow:hidden">
    <img src="${src(pagePng)}" style="position:absolute;left:0;top:0;width:${PAGE_W}px;height:${H}px">
    <img src="${src(panelPng)}" style="position:absolute;left:${PAGE_W}px;top:0;width:${PANEL_W}px;height:${H}px;border-left:1px solid #d6d9d5;box-sizing:border-box">`);
  await p.screenshot({ path: `${OUT}/${file}` });
  await p.close();
}

async function tiles(ctx, iconPng, panelPng) {
  const p = await ctx.newPage();
  const src = (b) => `data:image/png;base64,${b.toString('base64')}`;
  const font = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"; // single quotes: it sits inside style="…"
  await p.setViewportSize({ width: 440, height: 280 });
  await p.setContent(`<body style="margin:0;width:440px;height:280px;background:#fafaf8;font-family:${font};display:flex;flex-direction:column;justify-content:center;padding:0 40px;box-sizing:border-box;color:#1d211f">
    <img src="${src(iconPng)}" style="width:56px;height:56px;margin-bottom:18px">
    <div style="font-size:34px;font-weight:650;letter-spacing:-0.02em">SlopMachine</div>
    <div style="margin-top:6px;font-size:17px;color:#545c57">A second read before it goes out.</div>`);
  await p.screenshot({ path: `${OUT}/promo-small-440x280.png` });

  await p.setViewportSize({ width: 1400, height: 560 });
  await p.setContent(`<body style="margin:0;width:1400px;height:560px;background:#fafaf8;font-family:${font};color:#1d211f;position:relative;overflow:hidden">
    <div style="position:absolute;left:96px;top:150px;width:620px">
      <img src="${src(iconPng)}" style="width:64px;height:64px;margin-bottom:24px">
      <div style="font-size:52px;font-weight:650;letter-spacing:-0.02em;line-height:1.1">A second read before it goes out.</div>
      <div style="margin-top:18px;font-size:21px;line-height:1.5;color:#545c57">Flags generic, unclear and AI-sounding writing as you type. On your device, no account.</div>
    </div>
    <div style="position:absolute;right:120px;top:48px;width:${PANEL_W}px;height:464px;border:1px solid #e2e5e1;border-radius:10px;box-shadow:0 18px 48px rgb(0 0 0 / .12);background:#fafaf8 url('${src(panelPng)}') no-repeat left top / ${PANEL_W}px auto"></div>`);
  await p.screenshot({ path: `${OUT}/promo-marquee-1400x560.png` });
  await p.close();
}

/** The policy is plain Markdown (headings, paragraphs, lists, tables, bold, code, links); render it to one hostable page. */
function policyHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('# ')) { out.push(`<h1>${inline(line.slice(2))}</h1>`); i++; continue; }
    if (line.startsWith('## ')) { out.push(`<h2>${inline(line.slice(3))}</h2>`); i++; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (lines[i]?.startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.slice(1, -1).split('|').map((c) => inline(c.trim()));
      const [head, , ...body] = rows;
      out.push(`<div class="table"><table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const ordered = /^\d+\. /.test(line);
    if (ordered || line.startsWith('- ')) {
      const items = [];
      while (lines[i] !== undefined && (/^(\d+\. |- )/.test(lines[i]) || /^ {2,}\S/.test(lines[i]) || (!lines[i].trim() && /^ {2,}\S/.test(lines[i + 1] ?? '')))) {
        const l = lines[i++];
        if (/^(\d+\. |- )/.test(l)) items.push({ text: l.replace(/^(\d+\. |- )/, ''), parts: [] });
        else if (/^ {2,}- /.test(l)) items.at(-1).parts.push({ li: l.trim().slice(2) });
        else if (l.trim()) items.at(-1).parts.push({ p: l.trim() });
      }
      // Nested parts keep their order: paragraphs and runs of sub-items, as written.
      const nested = (parts) => {
        let html = '';
        for (let k = 0; k < parts.length;) {
          if (parts[k].p !== undefined) { html += `<p>${inline(parts[k++].p)}</p>`; continue; }
          const run = [];
          while (parts[k]?.li !== undefined) run.push(`<li>${inline(parts[k++].li)}</li>`);
          html += `<ul>${run.join('')}</ul>`;
        }
        return html;
      };
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.text)}${nested(it.parts)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (lines[i]?.trim() && !/^(#|\||- |\d+\. )/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SlopMachine privacy policy</title>
<style>
  :root { color-scheme: light dark; --bg: #fafaf8; --ink: #1d211f; --ink-2: #545c57; --rule: #e2e5e1; --surface: #eff1ee; --link: #2b5c9c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1a1d1b; --ink: #e6e9e5; --ink-2: #a4ada7; --rule: #2f3431; --surface: #242826; --link: #8db6f0; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 96px; }
  h1 { margin: 0 0 4px; font-size: 30px; letter-spacing: -0.02em; line-height: 1.2; }
  h2 { margin: 40px 0 8px; padding-top: 24px; border-top: 1px solid var(--rule); font-size: 19px; }
  h1 + p { color: var(--ink-2); font-size: 14px; }
  a { color: var(--link); overflow-wrap: anywhere; }
  code { padding: 1px 5px; border-radius: 4px; background: var(--surface); font-size: 0.88em; }
  li + li { margin-top: 6px; }
  li p { margin: 6px 0 0; }
  .table { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 15px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { color: var(--ink-2); font-weight: 600; }
</style>
</head>
<body><main>
${out.join('\n')}
</main></body>
</html>
`;
}

// ── Run ──────────────────────────────────────────────────────────────────────
await mkdir(OUT, { recursive: true });
execSync('node build.mjs', { stdio: 'ignore' }); // release build: the real icon and manifest
execSync('node build.mjs', { env: { ...process.env, E2E: '1' }, stdio: 'ignore' }); // test build to drive
await writeFile('store/privacy-policy.html', policyHtml(await readFile('store/privacy-policy.md', 'utf8')));
await copyFile('dist/icons/128.png', `${OUT}/icon-128.png`);

const server = http.createServer(async (q, r) => {
  const file = q.url?.startsWith('/article') ? 'article.html' : 'compose.html';
  r.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(`store/fixtures/${file}`));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// Reserved .example hostnames (mapped to the local server) so the panel shows a believable site, not 127.0.0.1.
const port = server.address().port;
const mail = `http://mail.northwind.example:${port}`;
const help = `http://help.fieldnote.example:${port}`;
const dist = path.join(tmpdir(), 'slopmachine-e2e');
const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--host-resolver-rules=MAP *.example 127.0.0.1'] });
await ctx.route('https://api.anthropic.com/**', async (route) => {
  const body = route.request().postData() ?? '';
  await new Promise((r) => setTimeout(r, 300));
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.includes('Page check v') ? PAGE_CHECK : DRAFT_REVIEW) });
});

const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const id = new URL(sw.url()).host;
const model = { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoning: true, maxOutput: 128000, lowEffort: true, structured: true };
await sw.evaluate(async ([settings]) => {
  await chrome.storage.local.set({ settings });
  await chrome.storage.session.set({ 'key:anthropic': 'sk-ant-example' });
  await chrome.scripting.registerContentScripts([{ id: 'store', matches: ['http://*.example/*'], js: ['content.js'] }]);
}, [{
  ...DEFAULT_SETTINGS, provider: 'byok', trustedVendors: ['anthropic'],
  byok: { vendor: 'anthropic', rememberKey: false, models: { openai: null, anthropic: model, google: null } },
}]);

const panel = await ctx.newPage();
await panel.setViewportSize({ width: PANEL_W, height: H });
await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
const [page] = await Promise.all([ctx.waitForEvent('page'), panel.evaluate((u) => chrome.tabs.create({ url: u }), `${mail}/compose`)]);
await page.setViewportSize({ width: PAGE_W, height: H });
await page.waitForLoadState();
await page.click('#body');
await page.keyboard.insertText(DRAFT);
const aiDone = () => panel.waitForFunction(() => / by /.test(document.getElementById('aiText')?.textContent ?? ''), null, { timeout: 30000 });
await aiDone();
await panel.waitForTimeout(400);
const shot = async (file) => {
  const panelPng = await panel.screenshot();
  await composite(ctx, await page.screenshot(), panelPng, file);
  return panelPng;
};

const marqueePanel = await shot('screenshot-1-review.png'); // the marquee shows the same finished review

for (const p of [page, panel]) await p.emulateMedia({ colorScheme: 'dark' });
await panel.waitForTimeout(400);
await shot('screenshot-5-dark.png');
for (const p of [page, panel]) await p.emulateMedia({ colorScheme: 'light' });
await panel.waitForTimeout(400);

await panel.getByRole('button', { name: /^Review all/ }).first().click();
await panel.waitForFunction(() => document.getElementById('proposal')?.hidden === false);
await panel.waitForTimeout(400);
await shot('screenshot-2-preview.png');
const clickIn = (sel) => panel.evaluate((q) => document.querySelector(q).click(), sel); // background tab: no visibility checks
await clickIn('#discardBtn');

await panel.selectOption('#purpose', 'docs');
await page.goto(`${help}/article`);
await panel.waitForFunction(() => document.getElementById('emptyAction')?.textContent === 'Review this page');
await clickIn('#emptyAction');
await aiDone();
await panel.waitForTimeout(400);
await shot('screenshot-3-page-check.png');

const opts = await ctx.newPage();
await opts.setViewportSize({ width: PAGE_W + PANEL_W, height: H });
await opts.goto(`chrome-extension://${id}/options/index.html#providers`);
await opts.waitForTimeout(500);
await opts.screenshot({ path: `${OUT}/screenshot-4-engines.png` });

await tiles(ctx, await readFile('dist/icons/128.png'), marqueePanel);
await ctx.close();
server.close();
console.log(`wrote ${OUT}/ and store/privacy-policy.html`);
