import { buildUserPrompt, SYSTEM_PROMPT, type RewriteOptions } from '../prompt.ts';
import { ProviderError, statusMessage, toProviderError } from '../providers.ts';
import { sanitizeOutput } from '../sanitize.ts';
import type { Task } from '../task.ts';
import { EDIT_TEMPERATURE, MAX_OUTPUT_TOKENS, VENDORS, type RemoteModel } from './types.ts';

const BASE = `${VENDORS.google.origin}/v1beta`;
const LABEL = VENDORS.google.label;
const NOT_TEXT = /(embedding|tts|image|live|audio|native|aqa|robotics|computer-use)/;

interface GoogleModel {
  name?: unknown;
  displayName?: unknown;
  outputTokenLimit?: unknown;
  supportedGenerationMethods?: unknown;
  thinking?: unknown;
}

const generation = (id: string): number => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);

export function toGoogleModel(m: GoogleModel): RemoteModel | null {
  if (typeof m.name !== 'string' || !m.name.startsWith('models/gemini-')) return null;
  if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) return null;
  const id = m.name.slice('models/'.length);
  if (NOT_TEXT.test(id)) return null;
  return {
    id,
    label: typeof m.displayName === 'string' ? m.displayName : id,
    reasoning: m.thinking === true || generation(id) >= 3,
    maxOutput: typeof m.outputTokenLimit === 'number' && m.outputTokenLimit > 0 ? m.outputTokenLimit : null,
    lowEffort: false,
  };
}

/**
 * Gemini 3+: sampling params are no longer recommended (below 1.0 can loop), so they are
 * dropped and thinkingLevel "low" keeps it quick. Gemini 2.5 thinking models take the older
 * thinkingBudget (the two can't be combined). Non-thinking models get a low temperature.
 */
export function googleBody(model: RemoteModel, draft: string, o: RewriteOptions): Record<string, unknown> {
  return googleTaskBody(model, { system: SYSTEM_PROMPT, user: buildUserPrompt(draft, o) });
}

export function googleTaskBody(model: RemoteModel, task: Task): Record<string, unknown> {
  const thinkingConfig = !model.reasoning ? undefined
    : generation(model.id) >= 3 ? { thinkingLevel: 'low' } : { thinkingBudget: 1024 };
  return {
    systemInstruction: { parts: [{ text: task.system }] },
    contents: [{ role: 'user', parts: [{ text: task.user }] }],
    generationConfig: {
      ...(task.json ? { responseMimeType: 'application/json' } : {}),
      // Thinking tokens count against this limit too.
      maxOutputTokens: model.maxOutput ? Math.min(model.maxOutput, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
      ...(thinkingConfig ? { thinkingConfig } : { temperature: EDIT_TEMPERATURE }),
    },
  };
}

const headers = (key: string) => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json' });

async function failure(res: Response): Promise<ProviderError> {
  // An invalid key is a 400 here, not a 401. Read the reason, never echo the body.
  const body = await res.text().catch(() => '');
  if (res.status === 400 && body.includes('API_KEY_INVALID')) return new ProviderError(statusMessage(401, LABEL));
  return new ProviderError(statusMessage(res.status, LABEL));
}

export async function listGoogleModels(key: string, signal: AbortSignal): Promise<RemoteModel[]> {
  try {
    const out: RemoteModel[] = [];
    let page = '';
    do {
      const res = await fetch(`${BASE}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, {
        headers: headers(key), credentials: 'omit', signal,
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { models?: GoogleModel[]; nextPageToken?: unknown };
      for (const m of body.models ?? []) {
        const model = toGoogleModel(m);
        if (model) out.push(model);
      }
      page = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    } while (page);
    return out.sort((a, b) => generation(b.id) - generation(a.id));
  } catch (e) {
    throw toProviderError(e, LABEL);
  }
}

export async function rewriteGoogle(
  key: string, model: RemoteModel, draft: string, o: RewriteOptions, signal: AbortSignal,
): Promise<{ text: string; servedBy: string }> {
  const out = await completeGoogle(key, model, { system: SYSTEM_PROMPT, user: buildUserPrompt(draft, o) }, signal);
  return { ...out, text: sanitizeOutput(out.text) };
}

export async function completeGoogle(key: string, model: RemoteModel, task: Task, signal: AbortSignal): Promise<{ text: string; servedBy: string }> {
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model.id)}:generateContent`, {
      method: 'POST', headers: headers(key), credentials: 'omit', signal, body: JSON.stringify(googleTaskBody(model, task)),
    });
    if (!res.ok) throw await failure(res);
    const body = (await res.json()) as {
      modelVersion?: unknown;
      promptFeedback?: { blockReason?: unknown };
      candidates?: { finishReason?: unknown; content?: { parts?: { text?: unknown; thought?: unknown }[] } }[];
    };
    const candidate = body.candidates?.[0];
    if (body.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(String(candidate?.finishReason))) {
      throw new ProviderError(`${LABEL} declined to rewrite this draft.`);
    }
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
    if (!text.trim()) {
      throw new ProviderError(candidate?.finishReason === 'MAX_TOKENS' ? `${LABEL} ran out of room before answering.` : `${LABEL} sent back an empty answer.`);
    }
    return { text, servedBy: typeof body.modelVersion === 'string' ? body.modelVersion : model.id };
  } catch (e) {
    throw toProviderError(e, LABEL);
  }
}
