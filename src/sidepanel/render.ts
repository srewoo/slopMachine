import type { DiffOp } from '../shared/diff.ts';
import type { Snapshot } from '../shared/messages.ts';
import { DEFAULT_SETTINGS } from '../shared/settings.ts';
import { FAMILY_LABELS, STATUS_LABELS, type Family, type Issue } from '../shared/types.ts';

const DEFAULT_MIN_WORDS = DEFAULT_SETTINGS.minWords;

type Ready = Extract<Snapshot, { state: 'ready' }>;

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

/** Text-only element builder. Nothing from a page or a model ever goes through innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

const SUMMARY: Readonly<Record<Family, string>> = {
  placeholder: 'a template tag is still in the text',
  leftovers: 'chatbot leftovers are still in the text',
  staging: 'some sentences stage a point instead of making it',
  generic: 'some phrases could fit any company',
  specificity: 'a claim or the ask is vague',
  structure: 'the rhythm is a little uniform',
  paste: 'it was pasted and not edited yet',
};

const SEVERITY_LABELS = { critical: 'Fix first', warning: 'Worth a look', info: 'Minor' } as const;

function summarize(byFamily: Readonly<Record<string, number>>): string {
  const top = (Object.entries(byFamily) as [Family, number][]).filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]);
  if (!top.length) return 'Nothing stands out. It reads like a person wrote it for this reader.';
  const parts = top.slice(0, 2).map(([f]) => SUMMARY[f]);
  const text = parts.join(', and ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function readTime(words: number): string {
  const minutes = Math.round(words / 200);
  return minutes < 1 ? 'under a minute to read' : `about ${minutes} min to read`;
}

export function renderScore(s: Ready): void {
  const a = s.analysis;
  const score = $('scoreNum').closest('.score') as HTMLElement;
  score.dataset['status'] = a.status;
  score.classList.remove('is-checking');
  $('scoreNum').textContent = String(a.score);
  $('scoreNum').setAttribute('aria-label', `Score ${a.score} of 100`);
  $('scoreStatus').textContent = STATUS_LABELS[a.status];
  $('summary').textContent = summarize(a.byFamily);

  const families = (Object.entries(a.byFamily) as [Family, number][]).filter(([, p]) => p > 0);
  $('bar').replaceChildren(...families.map(([f, p]) => {
    const seg = h('span', { title: `${FAMILY_LABELS[f]}: ${p}` });
    seg.style.width = `${p}%`;
    return seg;
  }));
  $('breakdown').replaceChildren(...families.flatMap(([f, p], i) => [i ? ' · ' : '', h('span', { class: 'nw' }, `${FAMILY_LABELS[f]} ${p}`)]));
  const sum = families.reduce((t, [, p]) => t + p, 0);
  if (sum > 100) $('breakdown').append(' · ', h('span', { class: 'nw' }, `${sum} in total, capped at 100`));
  $('meta').textContent = `${a.wordCount} words · ${readTime(a.wordCount)}`;
  $('truncated').hidden = !s.truncated;
  $('belowThreshold').hidden = s.eligible;
  $('thresholdText').textContent = `The toolbar badge appears once a draft reaches ${s.minWords} words.`;
  $('thresholdFix').hidden = s.minWords <= DEFAULT_MIN_WORDS;
}

export interface IssueHandlers {
  fix(issue: Issue): void;
  fixAll(issues: readonly Issue[]): void;
  reveal(issue: Issue): void;
  dismiss(issue: Issue): void;
  mute(issue: Issue): void;
}

/** The snippet is the "show in draft" control: click it to select that text in the page. */
function snippet(text: string, issue: Issue, onReveal: () => void, where: string): HTMLElement | null {
  if (issue.end <= issue.start) return null;
  const pad = 28;
  const from = Math.max(0, issue.start - pad);
  const to = Math.min(text.length, issue.end + pad);
  const cut = (s: string) => s.replace(/\s+/g, ' ');
  const match = text.slice(issue.start, issue.end);
  const shown = match.length > 140 ? `${match.slice(0, 137)}…` : match;
  const b = h('button', { class: 'snippet', type: 'button', title: `Show ${where}`, 'aria-label': `Show “${cut(shown).slice(0, 60)}” ${where}` },
    from > 0 ? '…' : '', cut(text.slice(from, issue.start)), h('mark', {}, cut(shown)), cut(text.slice(issue.end, to)), to < text.length ? '…' : '');
  b.addEventListener('click', onReveal);
  return b;
}

function button(cls: string, label: string, onClick: () => void, aria?: string): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button', ...(aria ? { 'aria-label': aria } : {}) }, label);
  b.addEventListener('click', onClick);
  return b;
}

const PLURAL: Readonly<Record<string, (n: number) => string>> = {
  placeholder: (n) => `Fill in ${n} template gaps`,
  phrase: (n) => `Swap ${n} stock phrases for something specific`,
  'numeric-claim': (n) => `Add sources for ${n} numbers or cut them`,
  'vague-cta': (n) => `Make the ask specific (${n} places)`,
};

const SHOWN_HITS = 4;

/** One row per rule: the explanation once, then each place it occurs. */
function groupRow(text: string, group: readonly Issue[], on: IssueHandlers, where: string): HTMLElement {
  const first = group[0]!;
  const n = group.length;
  const points = group.reduce((a, i) => a + i.points, 0);
  const titleId = `t-${first.ruleId}`;
  const label = (i: Issue) => text.slice(i.start, i.end).replace(/\s+/g, ' ').slice(0, 40);

  const hits = group.map((issue, idx) => {
    const actions = h('div', { class: 'issue-actions' });
    if (issue.fix) actions.append(button('btn', issue.fix.label, () => on.fix(issue)));
    actions.append(button('btn-quiet', 'Dismiss', () => on.dismiss(issue), `Dismiss “${label(issue) || issue.title}”`));
    if (issue.ruleId === 'phrase') actions.append(button('btn-quiet', 'Always allow', () => on.mute(issue), `Always allow “${label(issue)}”`));
    const li = h('li', { class: 'hit' }, snippet(text, issue, () => on.reveal(issue), where), actions);
    if (idx >= SHOWN_HITS) li.hidden = true;
    return li;
  });
  const list = h('ul', { class: 'hits' }, ...hits);

  const footer = h('div', { class: 'issue-actions group-actions' });
  const fixable = group.filter((i) => i.fix);
  if (fixable.length > 1) footer.append(button('btn', `Review all ${fixable.length} fixes`, () => on.fixAll(fixable)));
  if (n > SHOWN_HITS) {
    const more = button('btn-quiet', `Show ${n - SHOWN_HITS} more`, () => {
      hits.forEach((li) => (li.hidden = false));
      more.remove();
    });
    footer.append(more);
  }
  if (first.ruleId !== 'phrase' && first.source !== 'ai') footer.append(button('btn-quiet', 'Mute this rule', () => on.mute(first)));

  return h('li', { class: 'issue', 'data-severity': first.severity, 'aria-labelledby': titleId },
    h('div', { class: 'issue-head' },
      h('span', { class: 'sev' }, SEVERITY_LABELS[first.severity], first.source === 'ai' ? h('span', { class: 'tag-ai', title: 'Found by the AI review' }, 'AI') : null),
      first.source === 'ai'
        ? h('span', { class: 'pts', title: 'AI findings are listed but never change the score' }, 'not scored')
        : h('span', { class: 'pts num', title: 'Points this adds to the score' }, `+${points}`)),
    h('p', { class: 'issue-title', id: titleId }, n > 1 && PLURAL[first.ruleId] ? PLURAL[first.ruleId]!(n) : first.title),
    h('p', { class: 'why' }, first.message),
    list,
    footer.childElementCount ? footer : null);
}

const RANK = { critical: 0, warning: 1, info: 2 } as const;

/** Rule findings and AI findings in one list, most severe first (stable within a severity). */
export function renderIssues(s: Ready, on: IssueHandlers, aiIssues: readonly Issue[] = []): void {
  const all = [...s.analysis.issues, ...aiIssues].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const groups = new Map<string, Issue[]>();
  for (const issue of all) groups.set(issue.ruleId, [...(groups.get(issue.ruleId) ?? []), issue]);
  const total = all.length;
  $('issueCount').textContent = total ? `${total} ${total === 1 ? 'spot' : 'spots'}, ${groups.size} ${groups.size === 1 ? 'kind' : 'kinds'}` : '';
  $('noIssues').hidden = total > 0;
  const where = s.mode === 'page' ? 'on page' : 'in draft';
  $('issues').replaceChildren(...[...groups.values()].map((g) => groupRow(s.text, g, on, where)));
}

export type DiffMode = 'changes' | 'proposed' | 'original';

export function renderDiff(ops: readonly DiffOp[], mode: DiffMode): void {
  const nodes = ops.flatMap((op): (Node | string)[] => {
    if (op.type === 'eq') return [op.text];
    if (mode === 'proposed') return op.type === 'ins' ? [op.text] : [];
    if (mode === 'original') return op.type === 'del' ? [op.text] : [];
    const label = op.type === 'del' ? 'removed: ' : 'added: ';
    return [h(op.type, {}, h('span', { class: 'visually-hidden' }, label), op.text)];
  });
  $('diff').replaceChildren(...nodes);
}

/** Empty, unsupported and first-run states: a title, one sentence, and at most one action. */
export function showEmpty(title: string, body: string, action?: { label: string; run: () => void }): void {
  $('ready').hidden = true;
  $('empty').hidden = false;
  $('emptyTitle').textContent = title;
  $('emptyBody').textContent = body;
  const btn = $<HTMLButtonElement>('emptyAction');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.run;
  }
}

/** Copies to the clipboard; returns the line to show the user. */
export async function copyText(text: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return 'Copied. Paste it where you need it.';
  } catch {
    return "Couldn't reach the clipboard. Select the text in the preview and copy it.";
  }
}
