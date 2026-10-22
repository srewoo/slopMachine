import { buildUserPrompt, SYSTEM_PROMPT, type RewriteOptions } from '../prompt.ts';
import { ProviderError, statusMessage, toProviderError } from '../providers.ts';
import { sanitizeOutput } from '../sanitize.ts';
import type { Task } from '../task.ts';
import { EDIT_TEMPERATURE, MAX_OUTPUT_TOKENS, VENDORS, type RemoteModel } from './types.ts';

const BASE = `${VENDORS.openai.origin}/v1`;
const LABEL = VENDORS.openai.label;

// /v1/models lists every model on the account (audio, images, embeddings…); keep text chat models.
const CHAT = /^(gpt-|o\d|chatgpt-)/;
const NOT_CHAT = /(audio|realtime|tts|transcribe|search|image|instruct|embedding|moderation|codex|computer-use|deep-research)/;

/**
 * Reasoning models (o-series, GPT-5 and later, except the "-chat" variants) reject a
 * non-default temperature while reasoning is on. The models endpoint carries no capability
 * data, so this is decided from the id.
 */
export function isOpenAIReasoning(id: string): boolean {
  if (/^o\d/.test(id)) return true;
  const major = Number(/^gpt-(\d+)/.exec(id)?.[1] ?? 0);
  return major >= 5 && !/-chat/.test(id);
}

export function toOpenAIModel(id: string): RemoteModel {
  return { id, label: id, reasoning: isOpenAIReasoning(id), maxOutput: null, lowEffort: false };
}

export function openaiBody(model: RemoteModel, draft: string, o: RewriteOptions): Record<string, unknown> {
  return openaiTaskBody(model, { system: SYSTEM_PROMPT, user: buildUserPrompt(draft, o) });
}

export function openaiTaskBody(model: RemoteModel, task: Task): Record<string, unknown> {
  return {
    model: model.id,
    messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.user }],
    // JSON mode; the prompt itself also says JSON, which OpenAI requires alongside it.
    ...(task.json ? { response_format: { type: 'json_object' } } : {}),
    // max_tokens is deprecated and rejected by o-series; this cap includes reasoning tokens.
    max_completion_tokens: model.maxOutput ? Math.min(model.maxOutput, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
    ...(model.reasoning ? { reasoning_effort: 'low' } : { temperature: EDIT_TEMPERATURE }),
  };
}

const headers = (key: string) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

export async function listOpenAIModels(key: string, signal: AbortSignal): Promise<RemoteModel[]> {
  try {
    const res = await fetch(`${BASE}/models`, { headers: headers(key), credentials: 'omit', signal });
    if (!res.ok) throw new ProviderError(statusMessage(res.status, LABEL));
    const body = (await res.json()) as { data?: { id?: unknown; created?: unknown }[] };
    return (body.data ?? [])
      .filter((m): m is { id: string; created?: unknown } => typeof m.id === 'string' && CHAT.test(m.id) && !NOT_CHAT.test(m.id))
      .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))
      .map((m) => toOpenAIModel(m.id));
  } catch (e) {
    throw toProviderError(e, LABEL);
  }
}

export async function rewriteOpenAI(
  key: string, model: RemoteModel, draft: string, o: RewriteOptions, signal: AbortSignal,
): Promise<{ text: string; servedBy: string }> {
  const out = await completeOpenAI(key, model, { system: SYSTEM_PROMPT, user: buildUserPrompt(draft, o) }, signal);
  return { ...out, text: sanitizeOutput(out.text) };
}

export async function completeOpenAI(key: string, model: RemoteModel, task: Task, signal: AbortSignal): Promise<{ text: string; servedBy: string }> {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', headers: headers(key), credentials: 'omit', signal, body: JSON.stringify(openaiTaskBody(model, task)),
    });
    if (!res.ok) throw new ProviderError(statusMessage(res.status, LABEL));
    const body = (await res.json()) as { model?: unknown; choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }[] };
    const choice = body.choices?.[0];
    if (typeof choice?.message?.refusal === 'string' && choice.message.refusal) throw new ProviderError(`${LABEL} declined to rewrite this draft.`);
    const text = choice?.message?.content;
    if (choice?.finish_reason === 'length' && !text) throw new ProviderError(`${LABEL} ran out of room before answering. Try a non-reasoning model or a shorter draft.`);
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError(`${LABEL} sent back an empty answer.`);
    return { text, servedBy: typeof body.model === 'string' ? body.model : model.id };
  } catch (e) {
    throw toProviderError(e, LABEL);
  }
}
