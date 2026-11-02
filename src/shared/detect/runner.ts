/**
 * Runs the open detection models with Transformers.js. The same code runs in the extension's
 * worker (WebAssembly) and in the training harness (Node), so trained weights match what ships.
 * Revisions are pinned: the ensemble weights were fit against these exact files.
 */
import {
  AutoModelForCausalLM, AutoModelForSequenceClassification, AutoTokenizer, Tensor,
  type PreTrainedModel, type PreTrainedTokenizer, type ProgressCallback,
} from '@huggingface/transformers';
import { addTokenStats, type TokenStats } from './lm.ts';
import { BUNDLED_MODEL, DETECTION_MODELS, type Tier } from './tiers.ts';

export type { Tier } from './tiers.ts';

/** Tokens per language-model pass and per classifier pass. */
export const LM_MAX_TOKENS = 256;
export const CLS_MAX_TOKENS = 512;
/** Matches MAX_LEN in finetune.py. */
export const FT_MAX_TOKENS = 256;

interface Loaded {
  readonly ftTok?: PreTrainedTokenizer;
  readonly ft?: PreTrainedModel;
  readonly clsTok?: PreTrainedTokenizer;
  readonly cls?: PreTrainedModel;
  readonly lmTok?: PreTrainedTokenizer;
  readonly observer?: PreTrainedModel;
  readonly performer?: PreTrainedModel;
}

// Node (the training harness) runs on the native CPU backend; the extension runs WebAssembly.
const DEVICE = typeof process !== 'undefined' && !!process.versions?.node ? 'cpu' as const : 'wasm' as const;
const opts = (m: { revision: string }, progress?: ProgressCallback) => ({ revision: m.revision, dtype: 'int8' as const, device: DEVICE, ...(progress ? { progress_callback: progress } : {}) });

export class DetectionModels {
  private readonly m: Loaded;
  readonly tier: Tier;

  private constructor(m: Loaded, tier: Tier) {
    this.m = m;
    this.tier = tier;
  }

  /** The bundled model loads from env.localModelPath (the extension package, or static/models in Node). */
  static async load(tier: Tier, progress?: ProgressCallback, o2: { bundled?: boolean } = {}): Promise<DetectionModels> {
    const { classifier: c, observer: o, performer: p } = DETECTION_MODELS;
    // The training harness featurizes before the bundled model exists, so it can skip it.
    const [ftTok, ft] = o2.bundled === false ? [undefined, undefined] : await Promise.all([
      AutoTokenizer.from_pretrained(BUNDLED_MODEL, { local_files_only: true }),
      AutoModelForSequenceClassification.from_pretrained(BUNDLED_MODEL, { local_files_only: true, dtype: 'q8', device: DEVICE }),
    ]);
    if (tier === 'fast') return new DetectionModels({ ftTok, ft }, tier);
    const [clsTok, cls] = await Promise.all([
      AutoTokenizer.from_pretrained(c.id, { revision: c.revision }),
      AutoModelForSequenceClassification.from_pretrained(c.id, opts(c, progress)),
    ]);
    if (tier === 'classifier') return new DetectionModels({ ftTok, ft, clsTok, cls }, tier);
    const [lmTok, observer, performer] = await Promise.all([
      AutoTokenizer.from_pretrained(o.id, { revision: o.revision }),
      AutoModelForCausalLM.from_pretrained(o.id, opts(o, progress)),
      AutoModelForCausalLM.from_pretrained(p.id, opts(p, progress)),
    ]);
    return new DetectionModels({ ftTok, ft, clsTok, cls, lmTok, observer, performer }, tier);
  }

  private static async logit(tok: PreTrainedTokenizer, model: PreTrainedModel, text: string, max: number): Promise<number> {
    const { logits } = await model(tok(text, { truncation: true, max_length: max }));
    const [human, ai] = Array.from((logits as Tensor).data as Float32Array);
    return ai! - human!;
  }

  /** Bundled fine-tuned model's evidence as a logit: positive leans AI. Every tier has it. */
  bundled(text: string): Promise<number> {
    const { ftTok, ft } = this.m;
    if (!ftTok || !ft) throw new Error('The bundled detector was not loaded.');
    return DetectionModels.logit(ftTok, ft, text, FT_MAX_TOKENS);
  }

  /** RAID classifier's evidence as a logit, or undefined on the fast tier. */
  async classify(text: string): Promise<number | undefined> {
    const { clsTok, cls } = this.m;
    return clsTok && cls ? DetectionModels.logit(clsTok, cls, text, CLS_MAX_TOKENS) : undefined;
  }

  /** Adds the text's token statistics (first LM_MAX_TOKENS tokens) to `into`. No-op below the full tier. */
  async addLmStats(text: string, into: TokenStats): Promise<void> {
    const { lmTok, observer, performer } = this.m;
    if (!lmTok || !observer || !performer) return;
    const raw = Array.from((lmTok(text, { add_special_tokens: false }).input_ids as Tensor).data as BigInt64Array, Number);
    // Start from the end-of-text token so the first word is predicted too.
    const ids = [0, ...raw.slice(0, LM_MAX_TOKENS - 1)];
    if (ids.length < 3) return;
    const input_ids = new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const attention_mask = new Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);
    const [a, b] = [await observer({ input_ids, attention_mask }), await performer({ input_ids, attention_mask })];
    const lo = a.logits as Tensor;
    addTokenStats(into, ids, lo.data as Float32Array, (b.logits as Tensor).data as Float32Array, lo.dims[2]!);
  }
}
