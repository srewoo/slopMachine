/**
 * Token-level statistics from two small language models that share a tokenizer: an observer
 * (base model) and a performer (its instruction-tuned sibling). Pure math over logits, shared by
 * the in-browser worker and the training harness so both compute exactly the same numbers.
 *
 * - Perplexity and entropy: machine text sits in each model's high-probability zone.
 * - Binoculars (Hans et al. 2024): performer log-perplexity divided by the observer→performer
 *   cross-entropy. Low means "as predictable as a model would expect a model to be". Zero-shot.
 *
 * Rank statistics (GLTR's top-1/top-10 buckets) are deliberately absent: they flip on rounding
 * differences between the browser's WebAssembly kernels and native ones, so trained weights would
 * misread them. The parity test in test/e2e/detect.e2e.mjs holds every shipped feature to 3%.
 */

export interface TokenStats {
  readonly nllObs: number[];
  readonly nllPerf: number[];
  readonly xent: number[];
  readonly entropy: number[];
}

export const emptyStats = (): TokenStats => ({ nllObs: [], nllPerf: [], xent: [], entropy: [] });

/** Logits this far below a row's maximum carry under 1e-13 of the probability and are skipped. */
const NEGLIGIBLE = -30;

/** Appends one sequence's stats. Logits are row-major [tokens × vocab]; row t predicts ids[t + 1]. */
export function addTokenStats(into: TokenStats, ids: ArrayLike<number>, obs: Float32Array, perf: Float32Array, vocab: number): void {
  for (let t = 0; t + 1 < ids.length; t++) {
    const target = ids[t + 1]!;
    const o = t * vocab;
    let maxO = -Infinity;
    let maxP = -Infinity;
    for (let v = o; v < o + vocab; v++) {
      if (obs[v]! > maxO) maxO = obs[v]!;
      if (perf[v]! > maxP) maxP = perf[v]!;
    }
    // One pass: with e = exp(obs - maxO), entropy and cross-entropy follow from three sums.
    let sumO = 0;
    let sumP = 0;
    let eDo = 0; // Σ e·(obs − maxO)
    let eDp = 0; // Σ e·(perf − maxP)
    for (let v = o; v < o + vocab; v++) {
      const dO = obs[v]! - maxO;
      const dP = perf[v]! - maxP;
      if (dO > NEGLIGIBLE) {
        const e = Math.exp(dO);
        sumO += e;
        eDo += e * dO;
        eDp += e * dP;
      }
      if (dP > NEGLIGIBLE) sumP += Math.exp(dP);
    }
    const logSumO = Math.log(sumO);
    const logSumP = Math.log(sumP);
    into.nllObs.push(maxO + logSumO - obs[o + target]!);
    into.nllPerf.push(maxP + logSumP - perf[o + target]!);
    into.xent.push(logSumP - eDp / sumO); // −Σ p_obs · log p_perf
    into.entropy.push(logSumO - eDo / sumO); // −Σ p_obs · log p_obs
  }
}

export const LM_FEATURES = ['lm_nll_obs', 'lm_nll_perf', 'lm_xent', 'binoculars', 'lm_entropy', 'lm_nll_std'] as const;
export type LmFeature = (typeof LM_FEATURES)[number];

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function lmFeatures(s: TokenStats): Record<LmFeature, number> {
  const nllObs = mean(s.nllObs);
  const nllPerf = mean(s.nllPerf);
  const xent = mean(s.xent);
  return {
    lm_nll_obs: nllObs,
    lm_nll_perf: nllPerf,
    lm_xent: xent,
    binoculars: xent > 0 ? nllPerf / xent : 0,
    lm_entropy: mean(s.entropy),
    lm_nll_std: Math.sqrt(mean(s.nllObs.map((x) => (x - nllObs) ** 2))),
  };
}
