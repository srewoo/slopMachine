// Fits the four detection tiers, picks each tier's model by validation on held-out genres, sets
// thresholds from out-of-genre scores, evaluates every corpus, and writes src/shared/detect/weights.ts
// and docs/detection-eval.md.
// Usage: node scripts/detector/train.ts   (after the fetch, featurize, finetune and featurize_ft steps)
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { LM_FEATURES } from '../../src/shared/detect/lm.ts';
import { probability, type Detector } from '../../src/shared/detect/model.ts';
import { STYLE_FEATURES } from '../../src/shared/detect/stylometry.ts';
import { auroc, fitLogReg, fitTrees, type Row } from './fit.ts';
import { writeReport } from './report.ts';
import { EVAL, family, fineTuneSplit, genre, TRAIN, textId } from './splits.ts';

export type TierName = 'instant' | 'fast' | 'classifier' | 'full';
type Spec =
  | { readonly kind: 'logreg'; readonly features: readonly string[]; readonly l2: number }
  | { readonly kind: 'gbdt'; readonly features: readonly string[]; readonly depth: number; readonly rounds: number; readonly lr: number };

const STYLE = [...STYLE_FEATURES] as readonly string[];
const INPUTS: Readonly<Record<TierName, readonly (readonly string[])[]>> = {
  instant: [STYLE],
  fast: [['ft_logit'], ['ft_logit', 'log_words'], [...STYLE, 'ft_logit']],
  classifier: [['ft_logit', 'cls_logit'], ['ft_logit', 'cls_logit', 'log_words'], [...STYLE, 'ft_logit', 'cls_logit']],
  // Raw perplexity flags plain, simple English (non-native writers) as machine-like; Binoculars normalizes it away.
  full: [['ft_logit', 'cls_logit', 'binoculars'], [...STYLE, 'ft_logit', 'cls_logit', 'binoculars'], [...STYLE, 'ft_logit', 'cls_logit', ...LM_FEATURES]],
};
/** Logistic regression on each input set; boosted trees on each set that includes style statistics. */
const specs = (tier: TierName): Spec[] => [
  ...INPUTS[tier].flatMap((features) => [0.0001, 0.001, 0.01, 0.1].map((l2): Spec => ({ kind: 'logreg', features, l2 }))),
  ...INPUTS[tier].filter((f) => f.length >= STYLE.length).flatMap((features) =>
    [2, 3].flatMap((depth) => [150, 400].map((rounds): Spec => ({ kind: 'gbdt', features, depth, rounds, lr: 0.05 })))),
];
const fitSpec = (rows: readonly Row[], s: Spec): Detector => (s.kind === 'logreg' ? fitLogReg(rows, s.features, s.l2) : fitTrees(rows, s.features, s));
const describe = (s: Spec) => {
  const extra = s.features.filter((f) => !STYLE.includes(f));
  const inputs = s.features.length > extra.length ? `style${extra.length ? ` + ${extra.join(', ')}` : ''}` : extra.join(', ');
  return s.kind === 'logreg' ? `logistic regression on ${inputs}, L2 ${s.l2}` : `boosted trees on ${inputs}, depth ${s.depth}, ${s.rounds} rounds`;
};

/** Genres left out together: the human side and the AI side of the same kind of writing. */
const FOLD_GROUPS: readonly (readonly string[])[] = [['email'], ['docs'], ['school'], ['learner', 'essay'], ['post', 'mage/eli5', 'mage/yelp', 'mage/cmv', 'mage/tldr']];

const TARGET_FPR = 0.02; // "likely AI" (80+): at most this share of out-of-genre human text
const TARGET_LEAN_FPR = 0.1; // "leans AI" (60+)
const TARGET_MISS = 0.1; // "likely human" may wrongly clear at most this share of out-of-genre AI text
const isHoldout = (r: Row) => parseInt(r.id.slice(0, 4), 16) % 5 === 0;

async function readJsonl<T>(path: string): Promise<T[]> {
  return existsSync(path) ? (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}
/** Rows of a set: its current sample only, with model features and the bundled model's logit merged in. */
async function load(set: string): Promise<Row[]> {
  const raw = await readJsonl<{ text: string }>(`.cache/detector/raw/${set}.jsonl`);
  const ids = new Set(raw.map((r) => textId(r.text)));
  const ft = new Map((await readJsonl<{ id: string; ft_logit: number }>(`.cache/detector/features-ft/${set}.jsonl`)).map((r) => [r.id, r.ft_logit]));
  const rows = (await readJsonl<Row>(`.cache/detector/features/${set}.jsonl`)).filter((r) => ids.has(r.id));
  if (!rows.length) console.warn(`  ${set}: no features yet, skipped`);
  return [...new Map(rows.map((r) => {
    const f = ft.get(r.id);
    return [r.id, { ...r, source: genre(r), family: family(genre(r)), features: { ...r.features, ...(f !== undefined ? { ft_logit: f } : {}) } }];
  })).values()];
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]!;
};
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

function folds(rows: readonly Row[]): string[][] {
  const has = (gs: readonly string[], label: number) => rows.filter((r) => gs.includes(r.source) && r.label === label).length >= 10;
  const grouped = FOLD_GROUPS.map((g) => [...g]).filter((g) => has(g, 0) && has(g, 1));
  const taken = new Set(grouped.flat());
  const single = [...new Set(rows.map((r) => r.source))].filter((g) => !taken.has(g) && has([g], 0) && has([g], 1)).map((g) => [g]);
  return [...grouped, ...single];
}

/** Scores every row of each fold with a model that never saw that genre: transfer AUROC plus pooled out-of-genre scores. */
function leaveOneGenreOut(rows: readonly Row[], s: Spec, fs: readonly string[][]): { auroc: number; human: number[]; ai: number[] } {
  const human: number[] = [];
  const ai: number[] = [];
  const scores = fs.map((gs) => {
    const out = rows.filter((r) => gs.includes(r.source));
    const m = fitSpec(rows.filter((r) => !gs.includes(r.source)), s);
    const p = out.map((r) => probability(m, r.features));
    p.forEach((x, i) => (out[i]!.label ? ai : human).push(x));
    return auroc(p, out.map((r) => r.label)) ?? 0.5;
  });
  return { auroc: mean(scores), human, ai };
}

/** Mean AUROC over every (human genre, AI genre) pair in the held-out rows. */
function macroAuroc(m: Detector, rows: readonly Row[]): number {
  const srcs = (label: number) => [...new Set(rows.filter((r) => r.label === label).map((r) => r.source))];
  const score = (src: string, label: number) => rows.filter((r) => r.source === src && r.label === label).map((r) => probability(m, r.features));
  return mean(srcs(0).flatMap((hs) => srcs(1).map((as) => {
    const h = score(hs, 0);
    const a = score(as, 1);
    return h.length && a.length ? auroc([...a, ...h], [...a.map(() => 1), ...h.map(() => 0)])! : 0.5;
  })));
}

const train = (await Promise.all(TRAIN.map(async ([set, pick]) => (await load(set)).filter(pick)))).flat();
// The bundled model trained on split A; tiers that use its score learn only from split B.
const ensembleRows = train.filter((r) => !fineTuneSplit(r) && r.features.ft_logit !== undefined);
const evals: Record<string, Row[]> = {};
for (const [set, name, pick] of EVAL) evals[name] = (await load(set)).filter(pick);
evals['product mix: Claude business writing + business email'] = [...evals['Claude business writing']!, ...evals['business email (people)']!];
evals['all modern AI vs all people'] = [
  ...evals['modern AI (2025 chatbots)']!, ...evals['business email (people)']!, ...evals['English learners (people)']!, ...evals['technical answers (people)']!,
];
console.log(`  training rows: ${train.length} (ensemble split: ${ensembleRows.length})`);

const models = {} as Record<TierName, Detector>;
const heldModels = {} as Record<TierName, Detector>;
const chosen = {} as Record<TierName, string>;
for (const tier of ['instant', 'fast', 'classifier', 'full'] as const) {
  const rows = tier === 'instant' ? train : ensembleRows;
  const fitRows = rows.filter((r) => !isHoldout(r));
  const holdout = rows.filter(isHoldout);
  const fs = folds(fitRows);
  if (tier === 'instant') console.log(`  folds: ${fs.map((f) => f.join('+')).join(', ')}`);
  // Fixed in advance: half transfer to unseen genres, half separation on held-out rows of known ones.
  let best: { spec: Spec; held: Detector; score: number; lo: ReturnType<typeof leaveOneGenreOut>; macro: number } | null = null;
  for (const spec of specs(tier)) {
    const held = fitSpec(fitRows, spec);
    const lo = leaveOneGenreOut(fitRows, spec, fs);
    const macro = macroAuroc(held, holdout);
    const score = (lo.auroc + macro) / 2;
    if (!best || score > best.score) best = { spec, held, score, lo, macro };
  }
  const { spec, held, lo, macro } = best!;
  chosen[tier] = describe(spec);
  // Thresholds from out-of-genre scores: the extension mostly sees writing unlike its training data.
  const aiAt = quantile(lo.human, 1 - TARGET_FPR);
  const leanAt = Math.min(aiAt, quantile(lo.human, 1 - TARGET_LEAN_FPR));
  const humanAt = Math.min(leanAt, quantile(lo.ai, TARGET_MISS));
  models[tier] = { ...fitSpec(rows, spec), aiAt, leanAt, humanAt };
  heldModels[tier] = { ...held, aiAt, leanAt, humanAt };
  if (tier === 'fast') evals['held-out (training genres)'] = holdout;
  console.log(`  ${tier}: ${chosen[tier]} | unseen-genre AUROC ${(100 * lo.auroc).toFixed(1)}%, held-out ${(100 * macro).toFixed(1)}% | bands ${humanAt.toFixed(3)} / ${leanAt.toFixed(3)} / ${aiAt.toFixed(3)}`);
}

await writeReport({ models, heldModels, evals, chosen, trainCount: train.length, ensembleCount: ensembleRows.length });

const r = (x: number, digits = 6) => +x.toPrecision(digits);
const serialize = (m: Detector) => {
  const common = { features: m.features, mean: m.mean.map((x) => r(x)), aiAt: r(m.aiAt, 4), leanAt: r(m.leanAt, 4), humanAt: r(m.humanAt, 4) };
  if (m.kind === 'logreg') return { kind: m.kind, ...common, scale: m.scale.map((x) => r(x)), weights: m.weights.map((x) => r(x)), bias: r(m.bias) };
  return { kind: m.kind, ...common, base: r(m.base), trees: m.trees.map((t) => ({ ...t, cut: t.cut.map((x) => r(x)), value: t.value.map((x) => r(x, 5)) })) };
};
const out = Object.fromEntries((Object.keys(models) as TierName[]).map((t) => [t, serialize(models[t])]));
await writeFile('src/shared/detect/weights.ts', `// Generated by scripts/detector/train.ts. Do not edit by hand.\nimport type { Detector } from './model.ts';\n\nexport const DETECTORS: Readonly<Record<'instant' | 'fast' | 'classifier' | 'full', Detector>> = ${JSON.stringify(out)};\n`);
