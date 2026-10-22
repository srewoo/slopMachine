import * as z from 'zod/mini';

/** Upper bound for what a page check may send; the panel asks for less on small models. */
export const PAGE_OUTLINE_MAX = 40_000;

const family = z.enum(['placeholder', 'leftovers', 'staging', 'generic', 'specificity', 'structure', 'paste']);
const status = z.enum(['low', 'review', 'high']);
const offset = z.number().check(z.int(), z.gte(0));

const IssueSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  key: z.string(),
  family,
  severity: z.enum(['critical', 'warning', 'info']),
  start: offset,
  end: offset,
  title: z.string(),
  message: z.string(),
  points: z.number(),
  fix: z.optional(z.object({ label: z.string(), replacement: z.string(), start: offset, end: offset })),
});

const AnalysisSchema = z.object({
  score: z.number().check(z.gte(0), z.lte(100)),
  status,
  wordCount: z.number(),
  issues: z.readonly(z.array(IssueSchema)),
  byFamily: z.record(family, z.number()),
});

// Content script → service worker + side panel (runtime.sendMessage). Never carries draft text.
export const BroadcastSchema = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1), type: z.literal('analysis/updated'),
    editorId: z.string(), revision: z.string(), score: z.number(), status, wordCount: z.number(), eligible: z.boolean(),
  }),
  z.object({
    v: z.literal(1), type: z.literal('analysis/cleared'),
    reason: z.enum(['navigate', 'removed', 'blurred', 'unsupported', 'iframe']),
  }),
]);
export type Broadcast = z.infer<typeof BroadcastSchema>;

// Side panel → content script (tabs.sendMessage, frameId 0).
export const RequestSchema = z.discriminatedUnion('type', [
  z.object({ v: z.literal(1), type: z.literal('snapshot/get') }),
  z.object({ v: z.literal(1), type: z.literal('page/review') }),
  z.object({ v: z.literal(1), type: z.literal('page/outline'), revision: z.string(), max: z.number().check(z.int(), z.gt(0), z.lte(PAGE_OUTLINE_MAX)) }),
  z.object({ v: z.literal(1), type: z.literal('apply'), revision: z.string(), start: offset, end: offset, replacement: z.string().check(z.maxLength(20_000)) }),
  z.object({ v: z.literal(1), type: z.literal('reveal'), revision: z.string(), start: offset, end: offset }),
  z.object({ v: z.literal(1), type: z.literal('dismiss'), key: z.string() }),
]);
export type Request = z.infer<typeof RequestSchema>;

export const SnapshotSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('unsupported'), reason: z.enum(['iframe', 'readonly']) }),
  z.object({
    state: z.literal('ready'),
    /** 'page': a read-only page review the user asked for; edits can only be copied. */
    mode: z.enum(['editor', 'page']),
    editorId: z.string(),
    revision: z.string(),
    site: z.string(),
    text: z.string(),
    truncated: z.boolean(),
    eligible: z.boolean(),
    minWords: z.number(),
    canApply: z.boolean(),
    analysis: AnalysisSchema,
  }),
]);
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ApplyResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), revision: z.string() }),
  z.object({ ok: z.literal(false), reason: z.enum(['stale', 'verify-failed', 'unsupported']) }),
]);
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

export const OkSchema = z.object({ ok: z.boolean() });

export const OutlineSchema = z.object({ ok: z.literal(true), outline: z.string(), truncated: z.boolean() });
export type OutlineReply = z.infer<typeof OutlineSchema>;

// Options → service worker.
export const SyncSitesSchema = z.object({ v: z.literal(1), type: z.literal('sites/sync') });
