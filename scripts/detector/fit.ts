// Model fitting for the detection tiers: L2 logistic regression (Newton) and gradient-boosted trees
// (histogram splits, Newton leaf values). Both weight each (source, label) group equally.
import type { Boosted, LogReg, Tree } from '../../src/shared/detect/model.ts';

export interface Row {
  id: string; label: 0 | 1; source: string; meta?: string; gptzero?: { score?: number } | null; features: Record<string, number>;
  /** Writing family for balancing; defaults to source. */
  family?: string;
}

const placeholderThresholds = { aiAt: 0.5, leanAt: 0.5, humanAt: 0.5 };

/**
 * Every writing family weighs the same, split evenly between the labels it has, so big corpora can't
 * drown out small in-domain ones and no family can be learned as "the AI kind". Mean weight is 1.
 */
function groupWeights(rows: readonly Row[]): number[] {
  const fam = (r: Row) => r.family ?? r.source;
  const groups = new Map<string, number>();
  for (const r of rows) groups.set(`${fam(r)}:${r.label}`, (groups.get(`${fam(r)}:${r.label}`) ?? 0) + 1);
  const families = new Set(rows.map(fam));
  const labels = (f: string) => (groups.has(`${f}:0`) ? 1 : 0) + (groups.has(`${f}:1`) ? 1 : 0);
  return rows.map((r) => rows.length / (families.size * labels(fam(r)) * groups.get(`${fam(r)}:${r.label}`)!));
}

function matrix(rows: readonly Row[], features: readonly string[]): { X: number[][]; mean: number[] } {
  const raw = rows.map((r) => features.map((f) => r.features[f]));
  const mean = features.map((_, j) => {
    const vals = raw.map((x) => x[j]).filter((v): v is number => v !== undefined && Number.isFinite(v));
    return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  });
  return { X: raw.map((x) => x.map((v, j) => (v !== undefined && Number.isFinite(v) ? v : mean[j]!))), mean };
}

/** Solves A x = b (Gaussian elimination with partial pivoting); A is small and positive definite. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    [b[c], b[p]] = [b[p]!, b[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < n; k++) A[r]![k]! -= f * A[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) x[r] = (b[r]! - A[r]!.slice(r + 1).reduce((a, v, k) => a + v * x[r + 1 + k]!, 0)) / A[r]![r]!;
  return x;
}

export function fitLogReg(rows: readonly Row[], features: readonly string[], l2: number): LogReg {
  const { X, mean } = matrix(rows, features);
  const y = rows.map((r) => r.label);
  const sw = groupWeights(rows);
  const d = features.length;
  const scale = features.map((_, j) => Math.sqrt(X.reduce((a, x) => a + (x[j]! - mean[j]!) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => [...x.map((v, j) => Math.max(-5, Math.min(5, (v - mean[j]!) / scale[j]!))), 1]);
  const n = Z.length;
  const w = new Array<number>(d + 1).fill(0);
  for (let iter = 0; iter < 25; iter++) {
    const g = w.map((wj, j) => (j < d ? l2 * wj : 0));
    const H = w.map((_, i) => w.map((__, j) => (i === j && i < d ? l2 : 0)));
    for (let i = 0; i < n; i++) {
      const z = Z[i]!;
      const p = 1 / (1 + Math.exp(-z.reduce((a, v, j) => a + v * w[j]!, 0)));
      const e = (sw[i]! * (p - y[i]!)) / n;
      const h = (sw[i]! * p * (1 - p)) / n;
      for (let a = 0; a <= d; a++) {
        g[a]! += e * z[a]!;
        for (let b = a; b <= d; b++) H[a]![b]! += h * z[a]! * z[b]!;
      }
    }
    for (let a = 0; a <= d; a++) for (let b = 0; b < a; b++) H[a]![b] = H[b]![a]!;
    const step = solve(H, g);
    let moved = 0;
    for (let j = 0; j <= d; j++) { w[j]! -= step[j]!; moved = Math.max(moved, Math.abs(step[j]!)); }
    if (moved < 1e-7) break;
  }
  return { kind: 'logreg', features, mean, scale, weights: w.slice(0, d), bias: w[d]!, ...placeholderThresholds };
}

export interface TreeOptions { readonly depth: number; readonly rounds: number; readonly lr: number }
const LAMBDA = 1;
const MIN_HESS = 2; // about eight rows' worth of curvature per leaf, at mean weight 1
const BINS = 32;

export function fitTrees(rows: readonly Row[], features: readonly string[], o: TreeOptions): Boosted {
  const { X, mean } = matrix(rows, features);
  const y = rows.map((r) => r.label);
  const sw = groupWeights(rows);
  const n = rows.length;
  const d = features.length;
  // Candidate cuts: distinct quantiles per feature. bin(v) = number of cuts below v, so v <= cut[b] ⇔ bin <= b.
  const cuts = features.map((_, j) => {
    const s = X.map((x) => x[j]!).sort((a, b) => a - b);
    return [...new Set(Array.from({ length: BINS - 1 }, (_, k) => s[Math.floor(((k + 1) * (n - 1)) / BINS)]!))];
  });
  const bin = X.map((x) => x.map((v, j) => cuts[j]!.filter((c) => c < v).length));
  const wy = sw.reduce((a, w, i) => a + w * y[i]!, 0);
  const base = Math.log(wy / (sw.reduce((a, b) => a + b, 0) - wy));
  const F = new Float64Array(n).fill(base);
  const trees: Tree[] = [];
  for (let round = 0; round < o.rounds; round++) {
    const g = new Float64Array(n);
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = 1 / (1 + Math.exp(-F[i]!));
      g[i] = sw[i]! * (p - y[i]!);
      h[i] = sw[i]! * p * (1 - p);
    }
    const t = { feature: [] as number[], cut: [] as number[], left: [] as number[], right: [] as number[], value: [] as number[] };
    const leafOf = new Int32Array(n);
    const grow = (idx: number[], depth: number): number => {
      const id = t.feature.length;
      let G = 0;
      let H = 0;
      for (const i of idx) { G += g[i]!; H += h[i]!; }
      t.feature.push(-1); t.cut.push(0); t.left.push(-1); t.right.push(-1); t.value.push((-o.lr * G) / (H + LAMBDA));
      let best = { gain: 1e-6, f: -1, b: -1 };
      if (depth < o.depth) {
        for (let f = 0; f < d; f++) {
          const hg = new Float64Array(BINS);
          const hh = new Float64Array(BINS);
          for (const i of idx) { hg[bin[i]![f]!]! += g[i]!; hh[bin[i]![f]!]! += h[i]!; }
          let GL = 0;
          let HL = 0;
          for (let b = 0; b < cuts[f]!.length; b++) {
            GL += hg[b]!; HL += hh[b]!;
            const HR = H - HL;
            if (HL < MIN_HESS || HR < MIN_HESS) continue;
            const GR = G - GL;
            const gain = (GL * GL) / (HL + LAMBDA) + (GR * GR) / (HR + LAMBDA) - (G * G) / (H + LAMBDA);
            if (gain > best.gain) best = { gain, f, b };
          }
        }
      }
      if (best.f < 0) {
        for (const i of idx) leafOf[i] = id;
        return id;
      }
      t.feature[id] = best.f;
      t.cut[id] = cuts[best.f]![best.b]!;
      t.left[id] = grow(idx.filter((i) => bin[i]![best.f]! <= best.b), depth + 1);
      t.right[id] = grow(idx.filter((i) => bin[i]![best.f]! > best.b), depth + 1);
      return id;
    };
    grow(Array.from({ length: n }, (_, i) => i), 0);
    for (let i = 0; i < n; i++) F[i]! += t.value[leafOf[i]!]!;
    trees.push(t);
  }
  return { kind: 'gbdt', features, mean, base, trees, ...placeholderThresholds };
}

export function auroc(scores: readonly number[], labels: readonly number[]): number | null {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
