import { buildUserPrompt, SYSTEM_PROMPT, type RewriteOptions } from './prompt.ts';
import { sanitizeOutput, scrubError } from './sanitize.ts';
import type { Task } from './task.ts';

/** Shown to the user as-is: plain language, never the draft or the key. */
export class ProviderError extends Error {}

export type BuiltinState = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'missing';

interface LMSession {
  prompt(input: string, opts?: { signal?: AbortSignal; responseConstraint?: unknown }): Promise<string>;
  destroy(): void;
}
interface LMCreateOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  expectedInputs?: { type: 'text'; languages: string[] }[];
  expectedOutputs?: { type: 'text'; languages: string[] }[];
  signal?: AbortSignal;
  monitor?: (m: EventTarget) => void;
}
interface LMStatic {
  availability(o?: LMCreateOptions): Promise<Exclude<BuiltinState, 'missing'>>;
  create(o?: LMCreateOptions): Promise<LMSession>;
}

const LM = (): LMStatic | undefined => (globalThis as { LanguageModel?: LMStatic }).LanguageModel;
const IO: LMCreateOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

export async function builtinAvailability(): Promise<BuiltinState> {
  const lm = LM();
  if (!lm) return 'missing';
  try {
    return await lm.availability(IO);
  } catch {
    return 'unavailable';
  }
}

/**
 * Must be called synchronously inside the click handler (before any await):
 * a model download needs the user's activation.
 */
export function startBuiltinSession(signal: AbortSignal, onProgress: (fraction: number) => void, system = SYSTEM_PROMPT): Promise<LMSession> {
  const lm = LM();
  if (!lm) return Promise.reject(new ProviderError("Chrome's built-in AI isn't available in this browser."));
  return lm.create({
    ...IO,
    signal,
    initialPrompts: [{ role: 'system', content: system }],
    monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress((e as ProgressEvent).loaded)),
  });
}

export async function rewriteBuiltin(session: Promise<LMSession>, draft: string, o: RewriteOptions, signal: AbortSignal): Promise<string> {
  return sanitizeOutput(await completeBuiltin(session, buildUserPrompt(draft, o), signal));
}

/** Raw answer from a session started with the task's system prompt; JSON-constrained when a schema is given. */
export async function completeBuiltin(session: Promise<LMSession>, user: string, signal: AbortSignal, schema?: Task['json']): Promise<string> {
  let s: LMSession | undefined;
  try {
    s = await session;
    return await s.prompt(user, { signal, ...(schema ? { responseConstraint: schema } : {}) });
  } catch (e) {
    throw toProviderError(e, "Chrome's built-in AI");
  } finally {
    s?.destroy();
  }
}

const TIMEOUT_MS = 90_000;

export function toProviderError(e: unknown, label: string): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof DOMException && e.name === 'AbortError') return new ProviderError('Cancelled.');
  if (e instanceof DOMException && e.name === 'TimeoutError') return new ProviderError(`${label} took longer than 90 seconds. Nothing was changed.`);
  if (e instanceof TypeError) return new ProviderError(`Couldn't reach ${label}. Check that it is running and that SlopMachine has access to it in Settings.`);
  return new ProviderError(`${label} returned an error: ${scrubError(e instanceof Error ? e.message : String(e))}`);
}

export function statusMessage(status: number, label: string): string {
  if (status === 401 || status === 403) return `${label} rejected the key. Check it in Settings.`;
  if (status === 404) return `${label} doesn't know that model, or the endpoint path is wrong.`;
  if (status === 429) return `${label} is rate limiting this key. Try again in a minute.`;
  if (status >= 500) return `${label} had a server error (${status}). Try again later.`;
  return `${label} answered with status ${status}.`;
}

export interface Endpoint {
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly key?: string;
}

const headers = (key?: string): HeadersInit => ({ 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) });

/** One request, no retries: a retry would repeat a sensitive transfer. */
export async function rewriteOpenAICompatible(ep: Endpoint, draft: string, o: RewriteOptions, signal: AbortSignal): Promise<string> {
  return sanitizeOutput(await completeOpenAICompatible(ep, { system: SYSTEM_PROMPT, user: buildUserPrompt(draft, o) }, signal));
}

/** Raw answer. JSON mode isn't requested: local servers differ on support; the prompt asks for JSON instead. */
export async function completeOpenAICompatible(ep: Endpoint, task: Task, signal: AbortSignal): Promise<string> {
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: headers(ep.key),
      credentials: 'omit',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      body: JSON.stringify({
        model: ep.model,
        temperature: 0.4,
        messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.user }],
      }),
    });
    if (!res.ok) throw new ProviderError(statusMessage(res.status, ep.label));
    const body: unknown = await res.json();
    const content = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new ProviderError(`${ep.label} sent back an empty answer.`);
    return content;
  } catch (e) {
    throw toProviderError(e, ep.label);
  }
}

/** Connection test: lists models. Sends no draft text. */
export async function testEndpoint(ep: Endpoint): Promise<string> {
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/models`, {
      headers: headers(ep.key), credentials: 'omit', signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ProviderError(statusMessage(res.status, ep.label));
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    if (ep.model && ids.length && !ids.includes(ep.model)) return `Connected, but “${ep.model}” isn't in the model list. Available: ${ids.slice(0, 5).join(', ')}`;
    return `Connected. ${ids.length} model${ids.length === 1 ? '' : 's'} available.`;
  } catch (e) {
    throw toProviderError(e, ep.label);
  }
}
