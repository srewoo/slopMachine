/**
 * Dedicated worker for the deep AI-writing check. Downloads the pinned open models from Hugging Face
 * once (cached by the browser), then runs them with WebAssembly. Draft text never leaves this worker.
 */
import { env } from '@huggingface/transformers';
import { chunkText, MAX_LM_CHUNKS } from '../shared/detect/chunks.ts';
import type { DeepEvidence, Evidence } from '../shared/detect/detect.ts';
import { emptyStats, lmFeatures, type TokenStats } from '../shared/detect/lm.ts';
import { normalizeForDetection } from '../shared/detect/normalize.ts';
import { DetectionModels, type Tier } from '../shared/detect/runner.ts';

export type WorkerRequest = { readonly id: number; readonly tier: Tier; readonly text: string };
export type WorkerReply =
  | { readonly type: 'progress'; readonly id: number; readonly fraction: number }
  | { readonly type: 'result'; readonly id: number; readonly tier: Tier; readonly evidence: DeepEvidence }
  | { readonly type: 'error'; readonly id: number; readonly message: string };

/** Passages beyond this get the fast estimate only, so a very long page stays quick. */
const MAX_DEEP_PASSAGES = 12;

// The bundled model ships in the package under models/; the downloadable ones come from Hugging Face.
env.allowLocalModels = true;
env.localModelPath = new URL('../models/', import.meta.url).href;
env.useBrowserCache = true;
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = new URL('../ort/', import.meta.url).href; // packaged runtime; extensions may not load remote code
wasm.numThreads = 1; // threads need cross-origin isolation, which the side panel doesn't have

let loaded: { tier: Tier; models: Promise<DetectionModels> } | null = null;
const post = (r: WorkerReply) => self.postMessage(r);

function load(tier: Tier, id: number): Promise<DetectionModels> {
  const rank = { fast: 0, classifier: 1, full: 2 } as const;
  if (loaded && rank[loaded.tier] >= rank[tier]) return loaded.models;
  const files = new Map<string, { loaded: number; total: number }>();
  const models = DetectionModels.load(tier, (p) => {
    if (p.status !== 'progress' || !('file' in p)) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    const sum = [...files.values()].reduce((a, f) => ({ loaded: a.loaded + f.loaded, total: a.total + f.total }), { loaded: 0, total: 0 });
    if (sum.total) post({ type: 'progress', id, fraction: sum.loaded / sum.total });
  });
  loaded = { tier, models };
  models.catch(() => { if (loaded?.models === models) loaded = null; });
  return models;
}

async function evidenceFor(models: DetectionModels, raw: string): Promise<DeepEvidence> {
  const full = models.tier === 'full';
  // Language-model stats per normalized passage, shared between the document and its passages.
  const statsCache = new Map<string, TokenStats>();
  const statsOf = async (t: string) => {
    let s = statsCache.get(t);
    if (!s) {
      s = emptyStats();
      await models.addLmStats(t, s);
      statsCache.set(t, s);
    }
    return s;
  };
  const evidence = async (t: string, stats?: TokenStats): Promise<Evidence> => {
    const cls = await models.classify(t);
    return { ft: await models.bundled(t), ...(cls !== undefined ? { cls } : {}), ...(full && stats ? { lm: lmFeatures(stats) } : {}) };
  };

  const chunks: Evidence[] = [];
  const passages = chunkText(raw);
  if (passages.length >= 2) {
    for (const c of passages.slice(0, MAX_DEEP_PASSAGES)) {
      const t = normalizeForDetection(c.text).text;
      chunks.push(await evidence(t, full ? await statsOf(t) : undefined));
    }
  }
  const norm = normalizeForDetection(raw).text;
  let docStats: TokenStats | undefined;
  if (full) {
    // Same aggregation the training harness used: the first few passages, each its own pass.
    docStats = emptyStats();
    for (const c of chunkText(norm).slice(0, MAX_LM_CHUNKS)) {
      const s = await statsOf(c.text);
      for (const k of Object.keys(s) as (keyof TokenStats)[]) docStats[k].push(...s[k]);
    }
  }
  return { doc: await evidence(norm, docStats), chunks };
}

// Only the newest request matters: the draft keeps changing while the user types.
let latest = 0;
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, tier, text } = e.data;
  latest = id;
  try {
    const models = await load(tier, id);
    if (id !== latest) return;
    const evidence = await evidenceFor(models, text);
    if (id === latest) post({ type: 'result', id, tier: models.tier, evidence });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
