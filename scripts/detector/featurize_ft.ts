// Scores every fetched text with the bundled fine-tuned detector, through Transformers.js exactly as
// the extension runs it: .cache/detector/raw/<set>.jsonl → .cache/detector/features-ft/<set>.jsonl.
// Run after finetune.py; rerun from scratch whenever the model is retrained.
// Usage: node scripts/detector/featurize_ft.ts [set ...]
import { env } from '@huggingface/transformers';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { normalizeForDetection } from '../../src/shared/detect/normalize.ts';
import { DetectionModels } from '../../src/shared/detect/runner.ts';
import { loadRaw } from './splits.ts';

env.cacheDir = '.cache/detector/models';
env.allowLocalModels = true;
env.localModelPath = 'static/models/';
const OUT = '.cache/detector/features-ft';
await mkdir(OUT, { recursive: true });
const sets = process.argv.slice(2).length ? process.argv.slice(2) : (await readdir('.cache/detector/raw')).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
const models = await DetectionModels.load('fast');
for (const set of sets) {
  const lines: string[] = [];
  const t0 = Date.now();
  for (const r of await loadRaw(set)) lines.push(JSON.stringify({ id: r.id, ft_logit: await models.bundled(normalizeForDetection(r.text).text) }));
  await writeFile(`${OUT}/${set}.jsonl`, lines.join('\n') + '\n');
  console.log(`  ${set}: ${lines.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
