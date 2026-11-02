/** Model tiers and their one-time download sizes. Kept apart from runner.ts so pages can show them without bundling the model runtime. */
export type Tier = 'fast' | 'classifier' | 'full';

/** Fine-tuned for this project (scripts/detector/finetune.py) and shipped inside the extension: no download. */
export const BUNDLED_MODEL = 'slop-detector';

export const DETECTION_MODELS = {
  // RoBERTa-base fine-tuned on RAID with focal loss and hard-negative mining. MIT.
  classifier: { id: 'onnx-community/tmr-ai-text-detector-ONNX', revision: 'b9aa251e5bcda7e429fcc936767d921435945b60', mb: 126 },
  // SmolLM2-135M base and instruct share a tokenizer: the Binoculars observer/performer pair. Apache-2.0.
  observer: { id: 'onnx-community/SmolLM2-135M-ONNX', revision: 'd0ae6834f1df45e0e95b5fdae95e536f9ca7cd3f', mb: 136 },
  performer: { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', revision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', mb: 137 },
} as const;

export const TIER_MB: Readonly<Record<Tier, number>> = {
  fast: 0,
  classifier: DETECTION_MODELS.classifier.mb,
  full: DETECTION_MODELS.classifier.mb + DETECTION_MODELS.observer.mb + DETECTION_MODELS.performer.mb,
};
