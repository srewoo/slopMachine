import { completeRemote, VENDORS } from '../shared/byok/index.ts';
import { OutlineSchema, PAGE_OUTLINE_MAX, type Request, type Snapshot } from '../shared/messages.ts';
import { builtinAvailability, completeBuiltin, completeOpenAICompatible, ProviderError, startBuiltinSession } from '../shared/providers.ts';
import {
  buildPageReviewPrompt, buildReviewPrompt, findingsToIssues, PAGE_REVIEW_SCHEMA, PAGE_REVIEW_SYSTEM, parseReview, REVIEW_SCHEMA, REVIEW_SYSTEM,
  type Rating, type Review, type Verdicts,
} from '../shared/review.ts';
import { loadKey, updateSettings, type Settings } from '../shared/settings.ts';
import type { Task } from '../shared/task.ts';
import type { Issue } from '../shared/types.ts';
import { confirmRemote, engineStatus } from './engine.ts';
import { $, h } from './render.ts';

type Ready = Extract<Snapshot, { state: 'ready' }>;

type State =
  | { kind: 'idle' }
  | { kind: 'off'; text: string; action?: string }
  | { kind: 'ask'; text: string }
  | { kind: 'running'; label: string }
  | { kind: 'done'; label: string; review: Review; text: string; partial: boolean }
  | { kind: 'error'; text: string };

interface Deps {
  readonly settings: () => Settings;
  readonly ready: () => Ready | null;
  readonly changed: () => void;
  readonly openSettings: () => void;
  readonly ask: (msg: Request) => Promise<unknown>;
}

/** Chrome's on-device model has a small context window; everything else gets the full page cap. */
const ON_DEVICE_PAGE_MAX = 12_000;

const RATING_WORDS: Readonly<Record<keyof Verdicts, Readonly<Record<Rating, string>>>> = {
  complete: { good: 'Complete', partly: 'Partly complete', poor: 'Incomplete' },
  understandable: { good: 'Clear', partly: 'Partly clear', poor: 'Hard to follow' },
  voice: { good: 'Reads naturally', partly: 'Some AI-style habits', poor: 'Many AI-style habits' },
};
const VERDICT_LABELS: Readonly<Record<keyof Verdicts, string>> = { complete: 'Complete?', understandable: 'Understandable?', voice: 'Natural voice?' };

/**
 * Second pass after the deterministic rules. Runs by itself when the panel opens if that needs
 * no new consent (on-device, local, or a provider the user said not to ask about again);
 * otherwise it waits for a click. Findings live only in panel memory.
 */
export function createAiReview(d: Deps) {
  let state: State = { kind: 'idle' };
  let job: AbortController | null = null;
  let armed = true; // auto-run at most once per panel open, tab switch or page review
  const dismissed = new Set<string>();

  const set = (s: State) => {
    state = s;
    d.changed();
  };

  /** What gets sent: the draft, or for a reviewed page its structured outline. `payload` is shown in the consent dialog. */
  async function task(s: Ready, settings: Settings): Promise<{ task: Task; payload: string; partial: boolean } | null> {
    const flagged = [...new Set(s.analysis.issues.map((i) => (i.end > i.start ? `"${s.text.slice(i.start, i.end).slice(0, 80)}": ${i.title}` : i.title)))].slice(0, 25);
    if (s.mode !== 'page') {
      return { task: { system: REVIEW_SYSTEM, user: buildReviewPrompt(s.text, settings.purpose, flagged), json: REVIEW_SCHEMA }, payload: s.text, partial: false };
    }
    const max = settings.provider === 'builtin' ? ON_DEVICE_PAGE_MAX : PAGE_OUTLINE_MAX;
    const r = OutlineSchema.safeParse(await d.ask({ v: 1, type: 'page/outline', revision: s.revision, max }));
    if (!r.success) return null;
    const { outline, truncated } = r.data;
    return {
      task: { system: PAGE_REVIEW_SYSTEM, user: buildPageReviewPrompt(outline, settings.purpose, flagged, truncated), json: PAGE_REVIEW_SCHEMA },
      payload: outline,
      partial: truncated,
    };
  }

  /** `byUser`: from a click, so consent can be asked and Chrome's model may be downloaded. */
  function run(byUser: boolean): void {
    const s = d.ready();
    const settings = d.settings();
    if (!s || job) return;
    armed = false;
    const ac = new AbortController();
    job = ac;
    const system = s.mode === 'page' ? PAGE_REVIEW_SYSTEM : REVIEW_SYSTEM;
    // Synchronous for a click: Chrome's model download needs this activation.
    const session = settings.provider === 'builtin' && byUser ? startBuiltinSession(ac.signal, () => undefined, system) : null;
    session?.catch(() => undefined);

    void (async () => {
      let label = '';
      try {
        const st = await engineStatus(settings);
        if (!st.ready) return set({ kind: 'off', text: st.note || 'The AI engine is not ready.', action: 'Open Settings' });
        const prepared = await task(s, settings);
        if (!prepared) return set({ kind: 'error', text: 'The page changed before the check could start. Try again.' });
        const { task: t, payload, partial } = prepared;
        let answer: string;
        if (settings.provider === 'builtin') {
          label = "Chrome's built-in AI";
          if (!session && (await builtinAvailability()) !== 'available') return set({ kind: 'ask', text: "AI review needs Chrome's on-device model, a one-time download." });
          set({ kind: 'running', label });
          answer = await completeBuiltin(session ?? startBuiltinSession(ac.signal, () => undefined, system), t.user, ac.signal, t.json);
        } else if (settings.provider === 'local') {
          label = settings.local.model;
          set({ kind: 'running', label });
          answer = await completeOpenAICompatible({ label: 'Your local model', baseUrl: settings.local.baseUrl, model: settings.local.model }, t, ac.signal);
        } else if (settings.provider === 'byok') {
          const vendor = VENDORS[settings.byok.vendor];
          const model = settings.byok.models[vendor.id];
          if (!model) return set({ kind: 'off', text: `Pick a ${vendor.label} model in Settings.`, action: 'Open Settings' });
          if (!settings.trustedVendors.includes(vendor.id)) {
            if (!byUser) return set({ kind: 'ask', text: `AI review sends this draft to ${vendor.label}.` });
            const consent = await confirmRemote(payload, vendor, model.label, { purpose: s.mode === 'page' ? 'page' : 'review' });
            if (!consent.ok) return set({ kind: 'ask', text: `AI review sends this draft to ${vendor.label}. Nothing was sent.` });
            if (consent.remember) await updateSettings((cur) => ({ ...cur, trustedVendors: [...new Set([...cur.trustedVendors, vendor.id])] }));
          }
          label = `${model.label}, ${vendor.label}`;
          set({ kind: 'running', label });
          answer = (await completeRemote(vendor.id, await loadKey(vendor.id), model, t, ac.signal)).text;
        } else {
          return set({ kind: 'off', text: 'Add an AI engine in Settings for a deeper review.', action: 'Set one up' });
        }
        if (ac.signal.aborted || d.ready()?.editorId !== s.editorId) return;
        const review = parseReview(answer);
        set(review ? { kind: 'done', label, review, text: s.text, partial } : { kind: 'error', text: `The answer from ${label} couldn't be read. Try again.` });
      } catch (e) {
        if (ac.signal.aborted) return set({ kind: 'idle' });
        set({ kind: 'error', text: e instanceof ProviderError ? e.message : 'The AI review failed. The rule-based results above still stand.' });
      } finally {
        if (job === ac) job = null;
      }
    })();
  }

  const issues = (s: Ready): Issue[] =>
    state.kind === 'done' ? findingsToIssues(s.text, state.review, s.analysis.issues).filter((i) => !dismissed.has(i.key)) : [];

  return {
    /** Called on every render with a ready draft: the one automatic run per arming. */
    maybeAuto(s: Ready, settings: Settings): void {
      if (armed && settings.aiAuto && s.eligible && state.kind === 'idle') run(false);
      else if (state.kind === 'idle' && !settings.aiAuto) state = { kind: 'ask', text: 'Get a second opinion from your AI engine.' };
    },
    /** Panel opened on a new tab, a new page review, or the editor went away: forget everything. */
    reset(): void {
      job?.abort();
      job = null;
      armed = true;
      dismissed.clear();
      state = { kind: 'idle' };
    },
    dismiss(key: string): void {
      dismissed.add(key);
      d.changed();
    },
    /** AI findings mapped onto the current text; fixed or dismissed ones drop out. */
    issues,
    render(s: Ready | null): void {
      const line = $('aiLine');
      line.hidden = !s || state.kind === 'idle';
      $('aiOverall').hidden = state.kind !== 'done' || !state.review.overall;
      renderVerdicts(state.kind === 'done' ? state.review.verdicts : undefined);
      line.dataset['state'] = state.kind;
      const action = $<HTMLButtonElement>('aiAction');
      const show = (text: string, button?: string) => {
        $('aiText').textContent = text;
        action.hidden = !button;
        action.textContent = button ?? '';
      };
      if (!s) return;
      const what = s.mode === 'page' ? 'Page check' : 'AI review';
      if (state.kind === 'running') show(`${what} in progress with ${state.label}…`, 'Cancel');
      else if (state.kind === 'off') show(state.text, state.action);
      else if (state.kind === 'ask') show(state.text, 'Run AI review');
      else if (state.kind === 'error') show(state.text, 'Try again');
      else if (state.kind === 'done') {
        const n = issues(s).length;
        const edited = s.text !== state.text;
        const partial = state.partial ? ' It checked the first part of a long page.' : '';
        show(`${what} by ${state.label}: ${n ? `${n} more ${n === 1 ? 'thing' : 'things'} to look at, marked AI` : 'nothing more found'}.${partial}${edited ? ' The text has changed since.' : ''}`, edited ? 'Run again' : undefined);
        $('aiOverall').textContent = state.review.overall;
      }
    },
    /** The status line's button. */
    act(): void {
      if (state.kind === 'running') {
        job?.abort();
        return;
      }
      if (state.kind === 'off') return d.openSettings();
      state = { kind: 'idle' };
      run(true);
    },
  };
}

/** Three verdicts for a page check, each a rating in words plus the reason behind it. */
function renderVerdicts(v: Verdicts | undefined): void {
  const box = $('verdicts');
  box.hidden = !v;
  if (!v) return box.replaceChildren();
  box.replaceChildren(...(Object.keys(VERDICT_LABELS) as (keyof Verdicts)[]).map((k) => h('div', { class: 'verdict', 'data-rating': v[k].rating },
    h('dt', {}, VERDICT_LABELS[k]),
    h('dd', {}, h('strong', {}, RATING_WORDS[k][v[k].rating]), v[k].reason ? ` ${v[k].reason}` : ''))));
}

export type AiReview = ReturnType<typeof createAiReview>;
