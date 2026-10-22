import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicParams, anthropicTaskParams, toAnthropicModel } from '../src/shared/byok/anthropic.ts';
import { googleBody, googleTaskBody, toGoogleModel } from '../src/shared/byok/google.ts';
import { tuningNote } from '../src/shared/byok/index.ts';
import { isOpenAIReasoning, openaiBody, openaiTaskBody, toOpenAIModel } from '../src/shared/byok/openai.ts';
import { REVIEW_SCHEMA } from '../src/shared/review.ts';
import type { RemoteModel } from '../src/shared/byok/types.ts';
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings.ts';

const O = { tone: 'direct', length: 'same', preserveFacts: true, purpose: 'outreach' } as const;
const model = (over: Partial<RemoteModel>): RemoteModel => ({ id: 'x', label: 'x', reasoning: false, maxOutput: null, lowEffort: false, ...over });

test('OpenAI: reasoning models drop temperature and set low effort; others keep a low temperature', () => {
  for (const id of ['o3', 'o4-mini', 'gpt-5', 'gpt-5.2', 'gpt-6-luna']) assert.ok(isOpenAIReasoning(id), id);
  for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-5-chat-latest', 'chatgpt-4o-latest']) assert.ok(!isOpenAIReasoning(id), id);

  const r = openaiBody(toOpenAIModel('o3'), 'draft', O);
  assert.ok(!('temperature' in r));
  assert.equal(r['reasoning_effort'], 'low');
  assert.ok(!('max_tokens' in r), 'max_tokens is rejected by o-series');
  assert.ok(typeof r['max_completion_tokens'] === 'number');

  const c = openaiBody(toOpenAIModel('gpt-4o'), 'draft', O);
  assert.equal(c['temperature'], 0.4);
  assert.ok(!('reasoning_effort' in c));
});

test('Anthropic: never sends sampling params; effort only when advertised; fallback on supported models', () => {
  for (const m of [model({ id: 'claude-opus-5-5', lowEffort: true }), model({ id: 'claude-haiku-4-5' })]) {
    const p = anthropicParams(m, 'draft', O) as unknown as Record<string, unknown>;
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(k in p), `${m.id} ${k}`);
  }
  const opus = anthropicParams(model({ id: 'claude-opus-5-5', lowEffort: true, maxOutput: 128_000 }), 'd', O);
  assert.equal(opus.output_config?.effort, 'low');
  assert.equal(opus.max_tokens, 16_000);
  assert.equal(opus.fallbacks, 'default');
  assert.deepEqual(opus.betas, ['server-side-fallback-2026-07-01']);

  const haiku = anthropicParams(model({ id: 'claude-haiku-4-5', maxOutput: 8_000 }), 'd', O);
  assert.equal(haiku.output_config, undefined, 'effort is rejected by models that do not advertise it');
  assert.equal(haiku.max_tokens, 8_000);
  assert.equal(haiku.fallbacks, undefined);
});

test('Anthropic: model capabilities map to reasoning and effort flags', () => {
  const info = {
    id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_tokens: 128_000,
    capabilities: { thinking: { supported: true }, effort: { low: { supported: true } }, structured_outputs: { supported: true } },
  } as unknown as Parameters<typeof toAnthropicModel>[0];
  assert.deepEqual(toAnthropicModel(info), { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoning: true, maxOutput: 128_000, lowEffort: true, structured: true });
  const partial = toAnthropicModel({ ...info, capabilities: { thinking: { supported: true } } } as typeof info);
  assert.equal(partial.structured, false, 'a capability missing from the response means unsupported, not a crash');
  const bare = toAnthropicModel({ ...info, capabilities: null, max_tokens: null } as typeof info);
  assert.equal(bare.lowEffort, false);
  assert.equal(bare.maxOutput, null);
});

test('Google: Gemini 3 uses thinkingLevel, 2.5 thinking uses a budget, non-thinking keeps temperature', () => {
  const g = (m: RemoteModel) => googleBody(m, 'draft', O)['generationConfig'] as Record<string, unknown>;
  const g3 = g(model({ id: 'gemini-3.5-flash', reasoning: true, maxOutput: 65_536 }));
  assert.deepEqual(g3['thinkingConfig'], { thinkingLevel: 'low' });
  assert.ok(!('temperature' in g3));
  assert.equal(g3['maxOutputTokens'], 16_000);

  const g25 = g(model({ id: 'gemini-2.5-pro', reasoning: true }));
  assert.deepEqual(g25['thinkingConfig'], { thinkingBudget: 1024 });
  assert.ok(!('temperature' in g25));

  const g2 = g(model({ id: 'gemini-2.0-flash' }));
  assert.equal(g2['temperature'], 0.4);
  assert.ok(!('thinkingConfig' in g2));
});

test('Google: model list keeps generateContent text models only', () => {
  const base = { supportedGenerationMethods: ['generateContent'], outputTokenLimit: 65_536 };
  assert.equal(toGoogleModel({ ...base, name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', thinking: true })?.reasoning, true);
  assert.equal(toGoogleModel({ ...base, name: 'models/gemini-3.5-flash' })?.reasoning, true, 'Gemini 3+ always thinks');
  assert.equal(toGoogleModel({ ...base, name: 'models/text-embedding-004' }), null);
  assert.equal(toGoogleModel({ ...base, name: 'models/gemini-2.5-flash-preview-tts' }), null);
  assert.equal(toGoogleModel({ name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['embedContent'] }), null);
});

test('tuning note matches what is actually sent', () => {
  assert.match(tuningNote('openai', toOpenAIModel('o3')), /reasoning effort is set to low/);
  assert.match(tuningNote('openai', toOpenAIModel('gpt-4o')), /Temperature 0.4/);
  assert.match(tuningNote('anthropic', model({ id: 'claude-opus-5-5', lowEffort: true })), /Effort is set to low.*another Claude model/);
  assert.match(tuningNote('google', model({ id: 'gemini-3.5-flash', reasoning: true })), /thinking is set to low/);
});

test('settings: chosen BYOK models validate; malformed ones are rejected', () => {
  const ok = { ...DEFAULT_SETTINGS, provider: 'byok', byok: { ...DEFAULT_SETTINGS.byok, vendor: 'anthropic', models: { ...DEFAULT_SETTINGS.byok.models, anthropic: model({ id: 'claude-opus-5-5' }) } } };
  assert.ok(parseSettings(ok));
  assert.equal(parseSettings({ ...ok, byok: { ...ok.byok, vendor: 'mistral' } }), null);
  assert.equal(parseSettings({ ...ok, byok: { ...ok.byok, models: { ...ok.byok.models, google: { id: '' } } } }), null);
});

test('JSON tasks ask each provider for JSON in its own way', () => {
  const t = { system: 's', user: 'Reply as JSON', json: REVIEW_SCHEMA };
  assert.deepEqual(openaiTaskBody(toOpenAIModel('gpt-4o'), t)['response_format'], { type: 'json_object' });
  assert.equal((googleTaskBody(model({ id: 'gemini-3.5-flash', reasoning: true }), t)['generationConfig'] as Record<string, unknown>)['responseMimeType'], 'application/json');
  const a = anthropicTaskParams(model({ id: 'claude-opus-5-5', lowEffort: true, structured: true }), t);
  assert.equal(a.output_config?.format?.type, 'json_schema');
  assert.equal(a.output_config?.effort, 'low', 'effort and format live side by side');
  assert.equal(anthropicTaskParams(model({ id: 'claude-haiku-4-5' }), t).output_config, undefined, 'no structured outputs → prompt-only JSON');
  assert.ok(!('response_format' in openaiTaskBody(toOpenAIModel('gpt-4o'), { system: 's', user: 'u' })), 'rewrites stay plain text');
});
