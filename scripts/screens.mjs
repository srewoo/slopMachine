// Screenshots the real side panel and options page against a live draft, in both themes.
// Usage: node scripts/screens.mjs [outDir]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'screens';
const DRAFT = process.env.SM_DRAFT ?? `Hi {{first_name}},

In today's fast-paced business landscape, driving operational efficiency is paramount. We delve deep into our client's operational friction points to spearhead transformative growth. Our tailored, cutting-edge solution stands as a testament to our commitment to elevate pipeline momentum.

Moreover, our clients have experienced upwards of 43% synergy gains within their first quarter. [Insert company observation or recent news item here].

I would love to arrange a brief introductory call next Tuesday. Let's connect!

Best regards,
Outbound Specialist`;

execSync('node build.mjs', { env: { ...process.env, E2E: '1' }, stdio: 'ignore' });
const html = readFileSync('test/fixtures/compose.html');
const server = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(html));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const dist = path.join(tmpdir(), 'slopmachine-e2e');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const id = new URL(sw.url()).host;
await sw.evaluate(() => chrome.scripting.registerContentScripts([{ id: 'e2e', matches: ['http://127.0.0.1/*'], js: ['content.js'] }]));

const panel = await ctx.newPage();
await panel.setViewportSize({ width: 380, height: 2400 });
await panel.goto(`chrome-extension://${id}/sidepanel/index.html`);
// Open the draft tab from the panel's own window, like the real side panel beside its tab.
const [page] = await Promise.all([ctx.waitForEvent('page'), panel.evaluate((u) => chrome.tabs.create({ url: u }), url)]);
await page.waitForLoadState();
await page.click('#rich');
await page.keyboard.insertText(DRAFT);
await panel.waitForFunction(() => document.getElementById('ready')?.hidden === false); // background tab: visibility checks don't apply
await panel.waitForTimeout(300);

for (const scheme of ['light', 'dark']) {
  await panel.emulateMedia({ colorScheme: scheme });
  await panel.waitForTimeout(300); // let color transitions finish
  await panel.screenshot({ path: `${out}/panel-${scheme}.png`, fullPage: true });
}
await panel.emulateMedia({ colorScheme: 'light' });
await panel.getByRole('button', { name: /^Review all/ }).first().click();
await panel.waitForTimeout(300);
await panel.screenshot({ path: `${out}/panel-proposal.png`, fullPage: true });

const opts = await ctx.newPage();
await opts.setViewportSize({ width: 1100, height: 900 });
await opts.goto(`chrome-extension://${id}/options/index.html`);
await opts.click('input[value="byok"]');
await opts.waitForTimeout(200);
await opts.screenshot({ path: `${out}/options.png`, fullPage: true });

await ctx.close();
server.close();
console.log(`wrote ${out}/`);
