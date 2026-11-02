// Computes every detection feature for the fetched corpora with the exact code the extension runs:
// .cache/detector/raw/<set>.jsonl → .cache/detector/features/<set>.jsonl. Resumable.
// Usage: node scripts/detector/featurize.ts [set ...]
import { env } from '@huggingface/transformers';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chunkText, MAX_LM_CHUNKS } from '../../src/shared/detect/chunks.ts';
import { emptyStats, lmFeatures } from '../../src/shared/detect/lm.ts';
import { normalizeForDetection } from '../../src/shared/detect/normalize.ts';
import { DetectionModels } from '../../src/shared/detect/runner.ts';
import { styleFeatures } from '../../src/shared/detect/stylometry.ts';
import { fineTuneSplit, TRAIN } from './splits.ts';

env.cacheDir = '.cache/detector/models';
const RAW = '.cache/detector/raw';
const OUT = '.cache/detector/features';

interface Raw { text: string; label: 0 | 1; source: string; meta?: string; gptzero?: unknown }

await mkdir(OUT, { recursive: true });
const sets = process.argv.slice(2).length ? process.argv.slice(2) : (await readdir(RAW)).map((f) => f.replace(/\.jsonl$/, ''));
const models = await DetectionModels.load('full', undefined, { bundled: false }); // ft_logit comes from featurize_ft.ts

for (const set of sets) {
  const out = `${OUT}/${set}.jsonl`;
  const done = new Set(existsSync(out) ? (await readFile(out, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const rows: Raw[] = (await readFile(`${RAW}/${set}.jsonl`, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  let n = 0;
  const t0 = Date.now();
  for (const r of rows) {
    const id = createHash('sha1').update(r.text).digest('hex').slice(0, 16);
    if (done.has(id)) continue;
    const norm = normalizeForDetection(r.text);
    // Split A rows fine-tune the bundled model and otherwise only train the style-only instant tier,
    // so the costly model features are skipped for them.
    const row = { id, label: r.label, source: r.source, meta: r.meta, features: {} };
    const styleOnly = TRAIN.some(([name, pick]) => name === set && pick(row)) && fineTuneSplit(row);
    let features: Record<string, number> = styleFeatures(norm.text);
    if (!styleOnly) {
      const stats = emptyStats();
      for (const c of chunkText(norm.text).slice(0, MAX_LM_CHUNKS)) await models.addLmStats(c.text, stats);
      features = { ...features, cls_logit: (await models.classify(norm.text))!, ...lmFeatures(stats) };
    }
    await appendFile(out, JSON.stringify({ id, label: r.label, source: r.source, meta: r.meta, gptzero: r.gptzero, invisible: norm.invisible, homoglyphs: norm.homoglyphs, features }) + '\n');
    done.add(id);
    if (++n % 25 === 0) process.stdout.write(`\r  ${set}: ${done.size}/${rows.length} (${((Date.now() - t0) / n / 1000).toFixed(2)} s/text)   `);
  }
  console.log(`\n  ${set}: ${done.size}/${rows.length} done`);
}
