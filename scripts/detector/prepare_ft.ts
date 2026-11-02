// Writes split A of the training rows, normalized exactly as the extension normalizes text at run
// time, to .cache/detector/ft-train.jsonl for finetune.py.
import { writeFile } from 'node:fs/promises';
import { normalizeForDetection } from '../../src/shared/detect/normalize.ts';
import { family, fineTuneSplit, genre, loadRaw, TRAIN } from './splits.ts';

const out: string[] = [];
for (const [set, pick] of TRAIN) {
  const rows = await loadRaw(set).catch(() => []);
  const kept = rows.filter((r) => pick(r) && fineTuneSplit(r));
  for (const r of kept) out.push(JSON.stringify({ text: normalizeForDetection(r.text).text, label: r.label, source: family(genre(r)) }));
  console.log(`  ${set}: ${kept.length}`);
}
await writeFile('.cache/detector/ft-train.jsonl', out.join('\n') + '\n');
console.log(`  ft-train: ${out.length}`);
