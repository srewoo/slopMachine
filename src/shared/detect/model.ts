/**
 * The trained detectors: a calibrated logistic regression or a small gradient-boosted tree
 * ensemble, whichever validated better for a tier. Weights are fit by scripts/detector/train.ts
 * and written to weights.ts; nothing here is hand-tuned.
 */

interface Thresholds {
  readonly features: readonly string[];
  /** Training mean per feature: fills a missing input, and tells reasons whether a value is high or low. */
  readonly mean: readonly number[];
  /** At or above: "likely AI". At most 2% false alarms on every held-out human source. */
  readonly aiAt: number;
  /** At or above: "leans AI". At most 10% false alarms on every held-out human source. */
  readonly leanAt: number;
  /** Below: "likely human". Between this and leanAt: unclear. */
  readonly humanAt: number;
}

export interface LogReg extends Thresholds {
  readonly kind: 'logreg';
  readonly scale: readonly number[];
  readonly weights: readonly number[];
  readonly bias: number;
}

/** Nodes in parallel arrays. Leaf when feature is -1; otherwise go left when x <= cut. `value` is the node's log-odds, internal nodes included. */
export interface Tree {
  readonly feature: readonly number[];
  readonly cut: readonly number[];
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly value: readonly number[];
}

export interface Boosted extends Thresholds {
  readonly kind: 'gbdt';
  readonly base: number;
  readonly trees: readonly Tree[];
}

export type Detector = LogReg | Boosted;
export type Features = Readonly<Record<string, number>>;

// Out-of-range inputs (a pasted table, a wall of numbers) must not swing a linear model on their own.
const CLIP = 5;
const input = (m: Detector, x: Features, i: number) => {
  const v = x[m.features[i]!];
  return v !== undefined && Number.isFinite(v) ? v : m.mean[i]!;
};

/** Each feature's push on the log-odds. Trees use path attribution (the value change at each split). */
export function contributions(m: Detector, x: Features): { feature: string; value: number }[] {
  const out = m.features.map((feature) => ({ feature, value: 0 }));
  if (m.kind === 'logreg') {
    m.features.forEach((_, i) => {
      out[i]!.value = m.weights[i]! * Math.max(-CLIP, Math.min(CLIP, (input(m, x, i) - m.mean[i]!) / m.scale[i]!));
    });
    return out;
  }
  for (const t of m.trees) {
    let n = 0;
    while (t.feature[n] !== -1) {
      const f = t.feature[n]!;
      const next = input(m, x, f) <= t.cut[n]! ? t.left[n]! : t.right[n]!;
      out[f]!.value += t.value[next]! - t.value[n]!;
      n = next;
    }
  }
  return out;
}

function logOdds(m: Detector, x: Features): number {
  const base = m.kind === 'logreg' ? m.bias : m.base + m.trees.reduce((a, t) => a + t.value[0]!, 0);
  return contributions(m, x).reduce((a, c) => a + c.value, base);
}

export function probability(m: Detector, x: Features): number {
  return 1 / (1 + Math.exp(-logOdds(m, x)));
}

/** Score anchors on a 0–100 scale: below 30 likely human, 30–59 unclear, 60–79 leans AI, 80 and up likely AI. */
export const SCORE_ANCHORS = { human: 30, lean: 60, ai: 80 } as const;

/**
 * Maps a probability onto the score scale, piecewise-linearly between the trained thresholds, so
 * the number and the band always agree. A score, not a literal probability of AI authorship.
 */
export function displayScore(m: Detector, p: number): number {
  const knots: [number, number][] = [[0, 0], [m.humanAt, SCORE_ANCHORS.human], [m.leanAt, SCORE_ANCHORS.lean], [m.aiAt, SCORE_ANCHORS.ai], [1, 100]];
  let raw = 100;
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1]!;
    const [x1, y1] = knots[i]!;
    if (p <= x1) { raw = x1 > x0 ? y0 + ((p - x0) / (x1 - x0)) * (y1 - y0) : y1; break; }
  }
  // Rounding must never carry a score across a band edge.
  const [lo, hi] = p >= m.aiAt ? [80, 100] : p >= m.leanAt ? [60, 79] : p >= m.humanAt ? [30, 59] : [0, 29];
  return Math.min(hi, Math.max(lo, Math.round(raw)));
}
