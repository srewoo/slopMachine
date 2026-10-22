import type { RewriteOptions } from '../prompt.ts';
import type { Task } from '../task.ts';
import { anthropicParams, completeAnthropic, listAnthropicModels, rewriteAnthropic } from './anthropic.ts';
import { completeGoogle, googleBody, listGoogleModels, rewriteGoogle } from './google.ts';
import { completeOpenAI, listOpenAIModels, openaiBody, rewriteOpenAI } from './openai.ts';
import type { RemoteModel, Vendor } from './types.ts';

export * from './types.ts';

const TIMEOUT_MS = 90_000;
const withTimeout = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

/** Lists text models the key can use. Sends the key, never draft text. */
export function listModels(vendor: Vendor, key: string, signal: AbortSignal): Promise<RemoteModel[]> {
  const s = withTimeout(signal, 15_000);
  if (vendor === 'openai') return listOpenAIModels(key, s);
  if (vendor === 'anthropic') return listAnthropicModels(key, s);
  return listGoogleModels(key, s);
}

/** One request, no retries: a retry would repeat a sensitive transfer. */
export function rewriteRemote(
  vendor: Vendor, key: string, model: RemoteModel, draft: string, o: RewriteOptions, signal: AbortSignal,
): Promise<{ text: string; servedBy: string }> {
  const s = withTimeout(signal, TIMEOUT_MS);
  if (vendor === 'openai') return rewriteOpenAI(key, model, draft, o, s);
  if (vendor === 'anthropic') return rewriteAnthropic(key, model, draft, o, s);
  return rewriteGoogle(key, model, draft, o, s);
}

/** Any task (e.g. the AI review); raw answer, the caller validates it. One request, no retries. */
export function completeRemote(
  vendor: Vendor, key: string, model: RemoteModel, task: Task, signal: AbortSignal,
): Promise<{ text: string; servedBy: string }> {
  const s = withTimeout(signal, TIMEOUT_MS);
  if (vendor === 'openai') return completeOpenAI(key, model, task, s);
  if (vendor === 'anthropic') return completeAnthropic(key, model, task, s);
  return completeGoogle(key, model, task, s);
}

const SAMPLE = { tone: 'direct', length: 'same', preserveFacts: true, purpose: 'outreach' } as const;

/**
 * Plain-language description of how requests to this model are tuned. Read from the real
 * request builders, so the settings page can't drift from what is actually sent.
 */
export function tuningNote(vendor: Vendor, model: RemoteModel): string {
  if (vendor === 'openai') {
    const b = openaiBody(model, '', SAMPLE);
    return 'temperature' in b
      ? `Temperature ${String(b['temperature'])} keeps the rewrite close to your draft.`
      : `Reasoning model: temperature is left at OpenAI's default (it rejects other values) and reasoning effort is set to ${String(b['reasoning_effort'])}.`;
  }
  if (vendor === 'anthropic') {
    const p = anthropicParams(model, '', SAMPLE);
    return [
      "No temperature is sent: Anthropic's current API rejects sampling settings on every model.",
      p.output_config?.effort ? `Effort is set to ${p.output_config.effort} for a quick edit.` : 'This model uses its default thinking depth.',
      p.fallbacks ? 'If it declines, Anthropic may hand the request to another Claude model; the preview says which one wrote it.' : '',
    ].filter(Boolean).join(' ');
  }
  const g = googleBody(model, '', SAMPLE)['generationConfig'] as { temperature?: number; thinkingConfig?: Record<string, unknown> };
  if (g.thinkingConfig?.['thinkingLevel']) return `Thinking model: temperature stays at Google's default (lower values can make Gemini 3 loop) and thinking is set to ${String(g.thinkingConfig['thinkingLevel'])}.`;
  if (g.thinkingConfig) return `Thinking model: temperature stays at the default and thinking is capped at ${String(g.thinkingConfig['thinkingBudget'])} tokens.`;
  return `Temperature ${String(g.temperature)} keeps the rewrite close to your draft.`;
}
