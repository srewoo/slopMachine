import type { WorkerReply, WorkerRequest } from '../detect-worker/index.ts';
import { detectAuthorship, type Authorship, type Band, type DeepEvidence, type DetectTier } from '../shared/detect/detect.ts';
import type { Tier } from '../shared/detect/tiers.ts';
import type { Snapshot } from '../shared/messages.ts';
import type { AuthorshipOpinion } from '../shared/review.ts';
import type { Settings } from '../shared/settings.ts';
import { $, h } from './render.ts';

type Ready = Extract<Snapshot, { state: 'ready' }>;

interface Deps {
  readonly settings: () => Settings;
  readonly changed: () => void;
  readonly reveal: (start: number, end: number) => void;
  readonly opinion: (s: Ready | null) => { label: string; opinion: AuthorshipOpinion } | null;
  readonly openSettings: () => void;
}

type Status = { kind: 'idle' } | { kind: 'loading'; fraction: number } | { kind: 'running' } | { kind: 'error'; message: string };

const BAND_WORDS: Readonly<Record<Band, string>> = {
  ai: 'Probably AI-written',
  lean: 'Maybe AI-written',
  unclear: "Can't tell. Could be either, or AI text a person edited",
  human: 'Probably written by a person',
  short: 'Too short to tell',
};
const TIER_WORDS: Readonly<Record<DetectTier, string>> = {
  instant: 'Quick check while the models load',
  fast: 'Checked with the built-in model',
  classifier: 'Checked with two AI detectors',
  full: 'Checked with all on-device models',
};
const OPINION_WORDS: Readonly<Record<AuthorshipOpinion['rating'], string>> = { ai: 'thinks it was written by AI', mixed: 'thinks AI wrote it and a person edited it', human: 'thinks a person wrote it' };
/** Wait for typing to pause before running the models. */
const DEBOUNCE_MS = 700;

/**
 * The AI-writing estimate. Style statistics give an instant read on every render; the models run in a
 * worker on the current text and are used only while the text is unchanged.
 */
export function createAuthorship(d: Deps) {
  let worker: Worker | null = null;
  let seq = 0;
  let deep: { text: string; tier: Tier; evidence: DeepEvidence } | null = null;
  let status: Status = { kind: 'idle' };
  let pending: { text: string; tier: Tier } | null = null;
  let timer: number | undefined;

  const tierOf = (): Tier => d.settings().detection;
  const RANK: Readonly<Record<Tier, number>> = { fast: 0, classifier: 1, full: 2 };
  const covers = (have: Tier, want: Tier) => RANK[have] >= RANK[want];

  function spawn(): Worker {
    const w = new Worker(chrome.runtime.getURL('detect-worker.js'), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const r = e.data;
      if (r.id !== seq) return;
      if (r.type === 'progress') status = r.fraction < 1 ? { kind: 'loading', fraction: r.fraction } : { kind: 'running' };
      else if (r.type === 'result') {
        deep = { text: pending?.text ?? '', tier: r.tier, evidence: r.evidence };
        status = { kind: 'idle' };
      } else status = { kind: 'error', message: r.message };
      d.changed();
    };
    w.onerror = () => {
      status = { kind: 'error', message: 'The on-device models stopped unexpectedly.' };
      worker = null;
      d.changed();
    };
    return w;
  }

  function schedule(text: string): void {
    const tier = tierOf();
    if (deep && deep.text === text && covers(deep.tier, tier)) return;
    if (pending && pending.text === text && pending.tier === tier) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      worker ??= spawn();
      pending = { text, tier };
      const req: WorkerRequest = { id: ++seq, tier, text };
      if (status.kind !== 'loading') status = { kind: 'running' };
      worker.postMessage(req);
      d.changed();
    }, DEBOUNCE_MS);
  }

  function renderResult(s: Ready, a: Authorship): void {
    const box = $('authorship');
    box.dataset['band'] = a.band;
    const n = a.score;
    $('authNum').textContent = n === null ? '–' : String(n);
    $('authNum').setAttribute('aria-label', n === null ? 'No score' : `AI score ${n} of 100`);
    $('authBand').textContent = BAND_WORDS[a.band];
    $<HTMLElement>('authFill').style.width = `${n ?? 0}%`;

    const notes: string[] = [];
    if (a.band === 'short') notes.push(`Needs at least 50 words to tell. This has ${a.words}.`);
    else if (a.lowConfidence) notes.push('Short text, so this is a rough guess.');
    if (a.invisible || a.homoglyphs) notes.push(`Found ${a.invisible + a.homoglyphs} hidden or look-alike letters. People add these to fool AI detectors. They were ignored.`);
    $('authNote').textContent = notes.join(' ');
    $('authNote').hidden = !notes.length;

    // The two scores answer different questions; say so when they look like they disagree.
    const review = s.analysis.status;
    const contrast = a.band === 'ai' || a.band === 'lean'
      ? (review === 'low' ? 'Clean writing can still be AI-written. The two scores measure different things.' : '')
      : a.band === 'human' && review === 'high' ? 'Writing with problems can still be human. The two scores measure different things.' : '';
    $('authContrast').textContent = contrast;
    $('authContrast').hidden = !contrast;

    const ai = a.reasons.filter((r) => r.leansAi);
    const person = a.reasons.filter((r) => !r.leansAi);
    const group = (title: string, lean: string, rs: typeof a.reasons) => (rs.length
      ? [h('li', { class: 'lean-head', 'data-lean': lean }, title), ...rs.map((r) => h('li', { 'data-lean': lean }, r.text))] : []);
    $('authReasons').replaceChildren(...group('Looks like AI', 'ai', ai), ...group('Looks like a person', 'human', person));
    const count = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
    $('authSummary').textContent = a.band === 'short' ? '' : `${count(ai.length, 'sign')} point to AI, ${count(person.length, 'sign')} to a person.`;

    const list = $('authPassages');
    list.replaceChildren(...a.passages.map((q) => {
      const snippet = s.text.slice(q.start, q.end).replace(/\s+/g, ' ').trim();
      const btn = h('button', { type: 'button', class: 'passage', 'data-band': q.band, title: 'Show on page' },
        h('span', { class: 'passage-pct num' }, String(q.score)),
        h('span', { class: 'passage-text' }, snippet.length > 90 ? `${snippet.slice(0, 90)}…` : snippet));
      btn.addEventListener('click', () => d.reveal(q.start, q.end));
      return h('li', {}, btn);
    }));
    $('authPassagesWrap').hidden = !a.passages.length;
  }

  function renderStatus(a: Authorship): void {
    const tier = tierOf();
    let line = TIER_WORDS[a.tier];
    let button: string | null = null;
    if (status.kind === 'loading') line += `. Downloading the AI detectors, ${Math.round(status.fraction * 100)}%. Only the first time.`;
    else if (status.kind === 'running') line += '. Checking…';
    else if (status.kind === 'error') { line += `. The check failed: ${status.message}`; button = 'Settings'; }
    else if (tier === 'fast' && a.tier === 'fast') { line += '. A more thorough check is in Settings.'; button = 'Set up'; }
    $('authTier').textContent = line;
    const b = $<HTMLButtonElement>('authAction');
    b.hidden = !button;
    b.textContent = button ?? '';
  }

  return {
    /** Draws the section for the current text and queues a deep check if one is due. */
    render(s: Ready | null, hidden: boolean): void {
      $('authorship').hidden = hidden || !s;
      if (!s) return;
      const ev = deep && deep.text === s.text ? deep.evidence : undefined;
      const a = detectAuthorship(s.text, ev);
      renderResult(s, a);
      renderStatus(a);
      const op = d.opinion(s);
      $('authOpinion').hidden = !op;
      if (op) $('authOpinion').textContent = `${op.label} ${OPINION_WORDS[op.opinion.rating]}. ${op.opinion.reason}`;
      if (a.band !== 'short') schedule(s.text);
    },
    reset(): void {
      deep = null;
      pending = null;
      window.clearTimeout(timer);
      if (status.kind === 'running') status = { kind: 'idle' };
    },
    wire(): void {
      $('authAction').addEventListener('click', () => d.openSettings());
    },
  };
}
