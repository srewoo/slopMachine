/**
 * AI-authorship estimate. Pure: same text and evidence → same result.
 * The fast tier runs on style statistics alone; the classifier and full tiers add evidence the
 * worker computes with on-device models. All three are calibrated logistic regressions.
 */
import { chunkText, MIN_DETECT_WORDS } from './chunks.ts';
import type { LmFeature } from './lm.ts';
import { contributions, displayScore, probability, type Detector, type Features } from './model.ts';
import { normalizeForDetection } from './normalize.ts';
import { AI_SIDE, REASON_LABELS } from './reasons.ts';
import { styleFeatures } from './stylometry.ts';
import { DETECTORS } from './weights.ts';
import { analyze } from '../rules/engine.ts';

/** 'instant' is style statistics alone, shown until the worker's models answer. */
export type DetectTier = 'instant' | 'fast' | 'classifier' | 'full';
export type Band = 'short' | 'human' | 'unclear' | 'lean' | 'ai';

/** Model evidence for one passage: bundled-model logit, RAID classifier logit, language-model statistics. */
export interface Evidence {
  readonly ft?: number;
  readonly cls?: number;
  readonly lm?: Readonly<Record<LmFeature, number>>;
}

export interface DeepEvidence {
  readonly doc: Evidence;
  /** One per chunk from chunkText(raw), same order. */
  readonly chunks: readonly Evidence[];
}

export interface Reason {
  readonly text: string;
  readonly leansAi: boolean;
  /** 'pattern': a known AI-writing habit the rules found in the text, shown as evidence beside the model's reasons. */
  readonly kind?: 'pattern';
}

/** AI-writing habits worth naming as evidence, in plain words, with how often they appear. */
const PATTERNS: Readonly<Record<string, (n: number) => string>> = {
  'label-template': () => 'The same label template repeats item after item, a common AI layout',
  'bold-labels': () => 'Bold labels open item after item, a common AI layout',
  dashes: (n) => `Long dashes join ideas ${n} times, a common AI habit`,
  'not-x-but-y': () => 'Uses “not X, but Y” contrasts, a common AI habit',
  'chat-residue': () => 'Has chatbot leftovers, like “I hope this helps”',
  closer: () => 'Ends points with dramatic one-liners, a common AI habit',
  'run-up': () => 'Warms up before the point, like “Let’s dive in”',
  'faux-insight': () => 'Sets up points as secrets, like “what nobody tells you”',
  'rhetorical-setup': () => 'Stages suspense, like “Plot twist:” or “The result?”',
  'colon-reveal': () => 'Reveals points after a colon, like “The best part: it learns”',
  'synonym-cycling': () => 'Calls one thing by rotating names, a common AI habit',
  triads: (n) => `Lists things in threes ${n} times, a common AI habit`,
};

/** A pattern already covered by a model reason isn't repeated. */
const SAME_AS: Readonly<Record<string, string>> = { dashes: 'dash_rate', 'not-x-but-y': 'rule_staging', closer: 'rule_staging', 'run-up': 'rule_staging', 'chat-residue': 'rule_staging', 'faux-insight': 'rule_staging', 'rhetorical-setup': 'rule_staging', 'colon-reveal': 'rule_staging' };

function patternReasons(raw: string, shown: readonly Reason[]): Reason[] {
  const covered = new Set(Object.entries(SAME_AS).filter(([, f]) => shown.some((r) => r.leansAi && REASON_LABELS[f]?.includes(r.text))).map(([id]) => id));
  const hits = new Map<string, number>();
  for (const i of analyze(raw, { purpose: 'content', mutedRules: [], allowList: [], customPhrases: [] }).issues) {
    if (PATTERNS[i.ruleId] && !covered.has(i.ruleId)) hits.set(i.ruleId, (hits.get(i.ruleId) ?? 0) + 1);
  }
  const order = Object.keys(PATTERNS);
  return [...hits.entries()].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0])).slice(0, 2).map(([id, n]) => ({ text: PATTERNS[id]!(n), leansAi: true, kind: 'pattern' as const }));
}

export interface Passage {
  readonly start: number;
  readonly end: number;
  /** 0–100, anchored to the bands (see displayScore). */
  readonly score: number;
  readonly band: Band;
}

export interface Authorship {
  readonly tier: DetectTier;
  /** 0–100, anchored to the bands (see displayScore). Null when the text is too short to judge. */
  readonly score: number | null;
  readonly band: Band;
  readonly lowConfidence: boolean;
  readonly words: number;
  readonly reasons: readonly Reason[];
  /** Offsets into the original text. Present when there are two or more passages. */
  readonly passages: readonly Passage[];
  readonly invisible: number;
  readonly homoglyphs: number;
}

/** Below this, the estimate is shown but marked low-confidence. */
export const CONFIDENT_WORDS = 150;

const wordCount = (s: string) => s.match(/\S+/g)?.length ?? 0;

function features(raw: string, ev: Evidence | undefined): Features {
  return {
    ...styleFeatures(normalizeForDetection(raw).text),
    ...(ev?.ft !== undefined ? { ft_logit: ev.ft } : {}),
    ...(ev?.cls !== undefined ? { cls_logit: ev.cls } : {}),
    ...(ev?.lm ?? {}),
  };
}

function bandOf(m: Detector, p: number): Band {
  return p >= m.aiAt ? 'ai' : p >= m.leanAt ? 'lean' : p < m.humanAt ? 'human' : 'unclear';
}

function reasonsFor(m: Detector, x: Features, band: Band): Reason[] {
  // Explain in the direction of the verdict; for "unclear", show the strongest push each way.
  const above = (f: string) => {
    const i = m.features.indexOf(f);
    return (x[f] ?? m.mean[i]!) >= m.mean[i]!;
  };
  // Only reasons whose direction a person would recognise: the value sits on the side that points the same way the model pushed.
  const all = contributions(m, x).filter((c) => {
    const side = AI_SIDE[c.feature];
    return Math.abs(c.value) > 0.15 && REASON_LABELS[c.feature] && side && (above(c.feature) === (side === 'high')) === c.value > 0;
  });
  const ai = all.filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  const human = all.filter((c) => c.value < 0).sort((a, b) => a.value - b.value);
  const pick = band === 'ai' || band === 'lean' ? [...ai.slice(0, 3), ...human.slice(0, 1)] : band === 'human' ? [...human.slice(0, 3), ...ai.slice(0, 1)] : [...ai.slice(0, 2), ...human.slice(0, 2)];
  return pick.map((c) => {
    const [high, low] = REASON_LABELS[c.feature]!;
    return { text: above(c.feature) ? high : low, leansAi: c.value > 0 };
  });
}

/** Which tier the available evidence supports. */
function tierFor(ev: Evidence | undefined): DetectTier {
  if (ev?.ft === undefined) return 'instant';
  if (ev.cls === undefined) return 'fast';
  return ev.lm ? 'full' : 'classifier';
}

export function detectAuthorship(raw: string, deep?: DeepEvidence): Authorship {
  const norm = normalizeForDetection(raw);
  const words = wordCount(norm.text);
  const tier = tierFor(deep?.doc);
  const m = DETECTORS[tier];
  const base = { tier, words, invisible: norm.invisible, homoglyphs: norm.homoglyphs };
  if (words < MIN_DETECT_WORDS) return { ...base, score: null, band: 'short', lowConfidence: true, reasons: [], passages: [] };

  const x = features(raw, deep?.doc);
  const p = probability(m, x);
  const band = bandOf(m, p);
  const chunks = chunkText(raw);
  const passages = chunks.length < 2 ? [] : chunks.map((c, i) => {
    const ev = deep?.chunks[i];
    const cm = DETECTORS[tierFor(ev)];
    const cp = probability(cm, features(c.text, ev));
    return { start: c.start, end: c.end, score: displayScore(cm, cp), band: bandOf(cm, cp) };
  });
  // The model's own reasons first, then up to two named habits from the text itself.
  const modelReasons = reasonsFor(m, x, band);
  const reasons = [...modelReasons, ...patternReasons(raw, modelReasons)];
  return { ...base, score: displayScore(m, p), band, lowConfidence: words < CONFIDENT_WORDS, reasons, passages };
}
