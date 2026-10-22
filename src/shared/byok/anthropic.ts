import Anthropic from '@anthropic-ai/sdk';
import { buildUserPrompt, SYSTEM_PROMPT, type RewriteOptions } from '../prompt.ts';
import { ProviderError, statusMessage, toProviderError } from '../providers.ts';
import { sanitizeOutput } from '../sanitize.ts';
import type { Task } from '../task.ts';
import { MAX_OUTPUT_TOKENS, VENDORS, type RemoteModel } from './types.ts';

const LABEL = VENDORS.anthropic.label;

/** Models that accept server-side refusal fallback in its "default" (routed-by-category) form. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(key: string): Anthropic {
  return new Anthropic({
    apiKey: key,
    // The user's own key, called straight from the extension page; there is no server to proxy it.
    dangerouslyAllowBrowser: true,
    // A retry would send the draft again without the user asking. One request per Rewrite press.
    maxRetries: 0,
    timeout: 90_000,
  });
}

export function toAnthropicModel(m: Anthropic.ModelInfo): RemoteModel {
  return {
    id: m.id,
    label: m.display_name || m.id,
    // Optional chaining at every level: a capability missing from the response means unsupported.
    reasoning: m.capabilities?.thinking?.supported ?? false,
    maxOutput: m.max_tokens ?? null,
    lowEffort: m.capabilities?.effort?.low?.supported ?? false,
    structured: m.capabilities?.structured_outputs?.supported ?? false,
  };
}

/**
 * API version 2026-10-21 (the SDK default) rejects temperature/top_p/top_k on every model,
 * so none are sent. Thinking is left at each model's default; depth is lowered with
 * effort "low" where the model advertises it.
 */
export function anthropicParams(model: RemoteModel, draft: string, o: RewriteOptions): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return anthropicTaskParams(model, { system: SYSTEM_PROMPT, user: buildUserPrompt(draft, o) });
}

/** A JSON task uses structured outputs where the model supports them; otherwise the prompt asks for JSON. */
export function anthropicTaskParams(model: RemoteModel, task: Task): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  const outputConfig = {
    ...(model.lowEffort ? { effort: 'low' as const } : {}),
    ...(task.json && model.structured ? { format: { type: 'json_schema' as const, schema: task.json as Record<string, unknown> } } : {}),
  };
  return {
    model: model.id,
    max_tokens: model.maxOutput ? Math.min(model.maxOutput, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
    system: task.system,
    messages: [{ role: 'user', content: task.user }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(FALLBACK_MODELS.has(model.id) ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  };
}

function toError(e: unknown): ProviderError {
  if (e instanceof Anthropic.APIUserAbortError) return new ProviderError('Cancelled.');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError(`${LABEL} took longer than 90 seconds. Nothing was changed.`);
  if (e instanceof Anthropic.APIConnectionError) return toProviderError(new TypeError('network'), LABEL);
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') return new ProviderError(statusMessage(e.status, LABEL));
  return toProviderError(e, LABEL);
}

export async function listAnthropicModels(key: string, signal: AbortSignal): Promise<RemoteModel[]> {
  try {
    const out: RemoteModel[] = [];
    for await (const m of client(key).models.list({ limit: 100 }, { signal })) out.push(toAnthropicModel(m));
    return out;
  } catch (e) {
    throw toError(e);
  }
}

export async function rewriteAnthropic(
  key: string, model: RemoteModel, draft: string, o: RewriteOptions, signal: AbortSignal,
): Promise<{ text: string; servedBy: string }> {
  const out = await completeAnthropic(key, model, { system: SYSTEM_PROMPT, user: buildUserPrompt(draft, o) }, signal);
  return { ...out, text: sanitizeOutput(out.text) };
}

export async function completeAnthropic(key: string, model: RemoteModel, task: Task, signal: AbortSignal): Promise<{ text: string; servedBy: string }> {
  try {
    const res = await client(key).beta.messages.create(anthropicTaskParams(model, task), { signal });
    if (res.stop_reason === 'refusal') throw new ProviderError(`${LABEL} declined this request.`);
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text.trim()) {
      throw new ProviderError(res.stop_reason === 'max_tokens' ? `${LABEL} ran out of room before answering.` : `${LABEL} sent back an empty answer.`);
    }
    return { text, servedBy: res.model };
  } catch (e) {
    throw e instanceof ProviderError ? e : toError(e);
  }
}
