import * as z from 'zod/mini';

export type Vendor = 'openai' | 'anthropic' | 'google';

export interface VendorInfo {
  readonly id: Vendor;
  readonly label: string;
  /** Exact origin; must also be listed in the manifest's optional_host_permissions. */
  readonly origin: string;
  readonly keyPlaceholder: string;
}

export const VENDORS: Readonly<Record<Vendor, VendorInfo>> = {
  openai: { id: 'openai', label: 'OpenAI', origin: 'https://api.openai.com', keyPlaceholder: 'sk-…' },
  anthropic: { id: 'anthropic', label: 'Anthropic', origin: 'https://api.anthropic.com', keyPlaceholder: 'sk-ant-…' },
  google: { id: 'google', label: 'Google Gemini', origin: 'https://generativelanguage.googleapis.com', keyPlaceholder: 'AIza…' },
};

export const VENDOR_IDS = Object.keys(VENDORS) as Vendor[];

/** What we keep about the chosen model; enough to build a request without re-listing. */
export const RemoteModelSchema = z.object({
  id: z.string().check(z.minLength(1), z.maxLength(200)),
  label: z.string().check(z.maxLength(200)),
  /** Thinks before answering: sampling params are dropped and reasoning depth is set low instead. */
  reasoning: z.boolean(),
  maxOutput: z.nullable(z.number().check(z.int(), z.gt(0))),
  /** Anthropic: the model advertises output_config.effort "low". */
  lowEffort: z.boolean(),
  /** Anthropic: the model supports structured outputs (output_config.format). */
  structured: z.optional(z.boolean()),
});
export type RemoteModel = z.infer<typeof RemoteModelSchema>;

/** Temperature for non-reasoning models: low enough to stay close to the draft. */
export const EDIT_TEMPERATURE = 0.4;
export const MAX_OUTPUT_TOKENS = 16_000;
