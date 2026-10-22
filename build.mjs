// Bundles each entry point. Output paths are stable on purpose: dynamically registered
// content scripts reference "content.js" by name across extension updates.
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeIcons } from './scripts/icons.mjs';
import { zipDirectory } from './scripts/zip.mjs';

const watch = process.argv.includes('--watch');
const e2e = !!process.env.E2E;
// dist/ is the only build in the project. Test builds pre-grant permissions, so they go to the
// system temp folder (E2E_DIST) where they can never be mistaken for, or overwrite, the real one.
const E2E_DIST = path.join(tmpdir(), 'slopmachine-e2e');
const out = e2e ? E2E_DIST : 'dist';

// package.json is the single source of the version; Chrome only accepts 1–4 dot-separated integers.
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+(\.\d+){0,3}$/.test(version) || version.split('.').some((n) => Number(n) > 65535)) {
  throw new Error(`package.json version "${version}" is not a valid Chrome extension version (e.g. 1.2.3).`);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

if (e2e) console.warn(`E2E build → ${out} (test-only, outside the project).`);
const common = { define: { __E2E__: String(e2e) }, bundle: true, target: 'chrome116', logLevel: 'info', legalComments: 'none', minify: !watch, sourcemap: watch ? 'inline' : false };
const builds = [
  { ...common, entryPoints: { content: 'src/content/index.ts' }, format: 'iife', outdir: out },
  { ...common, entryPoints: { sw: 'src/sw/index.ts' }, format: 'esm', outdir: out },
  { ...common, entryPoints: { 'sidepanel/main': 'src/sidepanel/main.ts', 'options/main': 'src/options/main.ts' }, format: 'esm', outdir: out },
];

const copyStatic = async () => {
  const manifest = { ...JSON.parse(await readFile('static/manifest.json', 'utf8')), version };
  // Test-only build: pre-grant the fixture and provider origins so E2E runs skip Chrome's permission prompt
  // (provider traffic is intercepted by the test; nothing reaches the real APIs).
  if (e2e) {
    manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*', 'http://*.example/*', 'https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*'];
  }
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
  await cp('src/ui/base.css', `${out}/ui/base.css`);
  for (const page of ['sidepanel', 'options']) {
    await cp(`src/${page}/index.html`, `${out}/${page}/index.html`);
  }
  await cp('src/sidepanel/panel.css', `${out}/sidepanel/panel.css`);
  await cp('src/options/options.css', `${out}/options/options.css`);
  await writeIcons(`${out}/icons`);
  await cp('THIRD_PARTY_NOTICES.md', `${out}/THIRD_PARTY_NOTICES.md`); // MIT notice for adapted humanizer patterns
};

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  await copyStatic();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  await copyStatic();
  // Web Store package: release builds only.
  if (!e2e) {
    await mkdir('release', { recursive: true });
    const zip = `release/slopmachine-${version}.zip`;
    const files = await zipDirectory(out, zip);
    console.log(`\n  ${zip}  (${files} files, manifest version ${version})\n`);
  }
}
