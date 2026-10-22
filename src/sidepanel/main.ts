import { changedRange, diffStats, diffWords, type DiffOp } from '../shared/diff.ts';
import { ApplyResultSchema, OkSchema, SnapshotSchema, type Request, type Snapshot } from '../shared/messages.ts';
import { ProviderError } from '../shared/providers.ts';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, updateSettings, type Settings } from '../shared/settings.ts';
import { applyFixes } from '../shared/fixes.ts';
import { PURPOSES, type Purpose } from '../shared/prompt.ts';
import type { Fix, Issue } from '../shared/types.ts';
import { createAiReview } from './ai.ts';
import { engineStatus, readOptions, startRewrite } from './engine.ts';
import { followActiveTab } from './tabs.ts';
import { $, copyText, renderDiff, renderIssues, renderScore, showEmpty, type DiffMode } from './render.ts';

type Ready = Extract<Snapshot, { state: 'ready' }>;

interface Proposal {
  readonly source: 'local' | 'model';
  readonly label: string;
  readonly original: string;
  readonly proposed: string;
  readonly revision: string;
  readonly ops: readonly DiffOp[];
  readonly range: { start: number; end: number; replacement: string };
}

let tabId: number | null = null;
let snap: Snapshot | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let proposal: Proposal | null = null;
let job: AbortController | null = null;
let applyBlocked = false;
// The word threshold only gates the toolbar badge; an open panel reviews any draft with text in it.
const ready = (): Ready | null => (snap?.state === 'ready' && snap.analysis.wordCount > 0 ? snap : null);
const undoKey = /Mac/.test(navigator.userAgent) ? 'Cmd+Z' : 'Ctrl+Z';

const announce = (msg: string): void => void ($('live').textContent = msg);
const result = (msg: string): void => void ($('result').textContent = msg);

async function ask(msg: Request): Promise<unknown> {
  if (tabId === null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch {
    return null; // no content script in this tab: not a site the user turned on
  }
}

const ai = createAiReview({ settings: () => settings, ready: () => ready(), changed: () => render(), openSettings: () => openSettings('#providers'), ask });

async function reviewPage(): Promise<void> {
  ai.reset();
  const parsed = SnapshotSchema.safeParse(await ask({ v: 1, type: 'page/review' }));
  setSnapshot(parsed.success ? parsed.data : null);
  if (parsed.success && parsed.data.state === 'ready') announce('Reviewing this page.');
}

async function refresh(): Promise<void> {
  const parsed = SnapshotSchema.safeParse(await ask({ v: 1, type: 'snapshot/get' }));
  setSnapshot(parsed.success ? parsed.data : null);
}

function setSnapshot(next: Snapshot | null): void {
  const prev = ready();
  snap = next;
  const now = ready();
  // Privacy: once the editor is gone, its text, any proposal and any in-flight rewrite leave the panel.
  if (!now) {
    ai.reset();
    proposal = null;
    job?.abort();
    const consent = $<HTMLDialogElement>('consent');
    if (consent.open) consent.close('cancel');
  }
  if (now && prev?.analysis.status !== now.analysis.status) announce(`Score ${now.analysis.score}, ${now.analysis.status}`);
  render();
}

const openSettings = (hash = '') => void chrome.tabs.create({ url: chrome.runtime.getURL(`options/index.html${hash}`) });

function render(): void {
  $('context').textContent = snap?.state === 'ready' ? `${snap.site} · ${snap.mode === 'page' ? 'page' : 'draft'}` : '';
  if (!snap) {
    showEmpty('Nothing to check on this page', 'SlopMachine reads drafts only on sites you turn on, such as Gmail or LinkedIn.', { label: 'Choose sites', run: () => openSettings('#sites') });
  } else if (snap.state === 'none') {
    showEmpty(
      'Click into something you are writing',
      'An email, a post or a doc: the check runs as you type. To check a published article instead, review this page. Nothing leaves this device.',
      { label: 'Review this page', run: () => void reviewPage() },
    );
  } else if (snap.state === 'unsupported') {
    showEmpty('This editor is not supported yet', 'It sits in a frame SlopMachine does not read. Your draft was not touched.');
  } else if (snap.analysis.wordCount === 0) {
    showEmpty('Start writing', 'The check runs as you type. Nothing leaves this device.');
  } else {
    $('empty').hidden = true;
    $('ready').hidden = false;
    renderScore(snap);
    ai.maybeAuto(snap, settings);
    renderIssues(snap, issueHandlers, ai.issues(snap));
  }
  ai.render(ready());
  renderProposal();
  void renderEngine();
}

const issueHandlers = {
  fix(issue: Issue) {
    const s = ready();
    if (!s || !issue.fix) return;
    const f = issue.fix;
    propose('local', issue.source === 'ai' ? 'Suggested by the AI review. Read it before applying.' : 'From the list above. No model used.', s, s.text.slice(0, f.start) + f.replacement + s.text.slice(f.end));
  },
  fixAll(issues: readonly Issue[]) {
    const s = ready();
    if (!s) return;
    const fixes = issues.map((i) => i.fix).filter((f): f is Fix => !!f);
    propose('local', `${fixes.length} fixes from the list above. No model used.`, s, applyFixes(s.text, fixes));
  },
  async reveal(issue: Issue) {
    const s = ready();
    if (!s) return;
    const r = OkSchema.safeParse(await ask({ v: 1, type: 'reveal', revision: s.revision, start: issue.start, end: issue.end }));
    if (!r.success || !r.data.ok) void refresh();
  },
  async dismiss(issue: Issue) {
    if (issue.source === 'ai') return ai.dismiss(issue.key);
    await ask({ v: 1, type: 'dismiss', key: issue.key });
    announce('Dismissed for this draft.');
    void refresh();
  },
  async mute(issue: Issue) {
    const s = ready();
    if (!s) return;
    const phrase = s.text.slice(issue.start, issue.end).toLowerCase();
    settings = await updateSettings((cur) => issue.ruleId === 'phrase'
      ? { ...cur, allowList: [...new Set([...cur.allowList, phrase])] }
      : { ...cur, mutedRules: [...new Set([...cur.mutedRules, issue.ruleId])] });
    result(issue.ruleId === 'phrase' ? `“${phrase}” won't be flagged again. Undo in Settings.` : 'Rule muted. Turn it back on in Settings.');
  },
};

function propose(source: Proposal['source'], label: string, s: Ready, proposed: string): void {
  const ops = diffWords(s.text, proposed);
  proposal = { source, label, original: s.text, proposed, revision: s.revision, ops, range: changedRange(s.text, proposed) };
  applyBlocked = false;
  result('');
  renderProposal();
  $('proposal').scrollIntoView({ block: 'start' });
  $('proposalHeading').focus({ preventScroll: true });
  announce('Proposed change ready. Review it, then apply or copy.');
}

function renderProposal(): void {
  const p = proposal;
  const s = ready();
  $('proposal').hidden = !p;
  $('footActions').hidden = !p;
  // While a proposal is open, the list it was built from is frozen out of reach.
  $('issuesSection').hidden = !!p;
  $('rewriteSection').hidden = !!p;
  if (!p) return;
  const stale = !s || s.revision !== p.revision;
  const { removed, added } = diffStats(p.ops);
  $('diffStats').textContent = `${removed} words out, ${added} in`;
  $('proposalSource').textContent = p.label;
  $('caveat').hidden = p.source === 'local';
  $('stale').hidden = !stale;
  $('regenerateStale').textContent = p.source === 'model' ? 'Regenerate' : 'Discard and review again';
  const apply = $<HTMLButtonElement>('applyBtn');
  // A reviewed page is read-only: no Apply, Copy becomes the main action.
  const readOnly = s?.mode === 'page';
  apply.disabled = stale || !!job || applyBlocked;
  apply.hidden = applyBlocked || readOnly;
  $('copyBtn').classList.toggle('btn-primary', readOnly || applyBlocked);
  renderDiff(p.ops, (document.querySelector<HTMLInputElement>('input[name="diffMode"]:checked')?.value ?? 'changes') as DiffMode);
}

async function renderEngine(): Promise<void> {
  const st = await engineStatus(settings);
  const none = settings.provider === 'none';
  $('rewriteControls').hidden = none;
  $('rewriteActions').hidden = none;
  $('engineName').textContent = none ? 'Rewriting the whole draft needs a model.' : st.label;
  $('engineNote').textContent = none ? '' : st.note;
  $('engineNote').hidden = none || !st.note;
  $('changeEngine').textContent = none ? 'Choose one in Settings' : 'Change';
  $('privacy').textContent = st.privacy;
  const s = ready();
  $<HTMLButtonElement>('rewriteBtn').disabled = !st.ready || !s || s.truncated || !!job;
}

function setBusy(busy: boolean): void {
  $('rewriteBtn').textContent = busy ? 'Rewriting…' : 'Rewrite';
  $('cancelBtn').hidden = !busy;
  for (const el of document.querySelectorAll<HTMLInputElement>('#tone input, #length input, #keepFacts')) el.disabled = busy;
  void renderEngine();
  renderProposal();
}

function rewrite(): void {
  const s = ready();
  if (!s || job) return;
  const ac = new AbortController();
  job = ac;
  $('rewriteStatus').textContent = '';
  setBusy(true);
  // Synchronous up to here: the built-in model's first download needs this click's activation.
  startRewrite(settings, s.text, readOptions(settings.purpose), ac.signal, (m) => ($('rewriteStatus').textContent = m)).then(({ text, label }) => {
    $('rewriteStatus').textContent = '';
    // The editor may have gone away (or been swapped) while we waited: never resurrect its text.
    if (ac.signal.aborted || ready()?.editorId !== s.editorId) return;
    if (text.trim() === s.text.trim()) $('rewriteStatus').textContent = 'The engine sent back the same text. Nothing to apply.';
    else propose('model', `Rewritten by ${label}`, s, text);
  }, (e: unknown) => {
    $('rewriteStatus').textContent = e instanceof ProviderError ? e.message : 'Something went wrong. Your draft was not changed.';
  }).finally(() => {
    job = null;
    setBusy(false);
  });
}

async function apply(): Promise<void> {
  const p = proposal;
  if (!p) return;
  const r = ApplyResultSchema.safeParse(await ask({ v: 1, type: 'apply', revision: p.revision, ...p.range }));
  const site = snap?.state === 'ready' ? snap.site : 'The page';
  if (r.success && r.data.ok) {
    proposal = null;
    result(`Applied. Press ${undoKey} in ${site} to undo.`);
    await refresh();
  } else if (r.success && !r.data.ok && r.data.reason === 'stale') {
    await refresh();
    result('Your draft changed. Review or regenerate.');
  } else {
    applyBlocked = true;
    renderProposal();
    result(`${site} didn't accept the edit. Copy it instead.`);
  }
}

async function copy(): Promise<void> {
  if (proposal) result(await copyText(proposal.proposed));
}

function wire(): void {
  $('openSettings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
  $('changeEngine').addEventListener('click', () => openSettings('#providers'));
  $('rewriteBtn').addEventListener('click', rewrite);
  $('cancelBtn').addEventListener('click', () => job?.abort());
  $('applyBtn').addEventListener('click', () => void apply());
  $('copyBtn').addEventListener('click', () => void copy());
  $('discardBtn').addEventListener('click', () => { proposal = null; result(''); renderProposal(); });
  $('regenerateStale').addEventListener('click', () => {
    const fromModel = proposal?.source === 'model';
    proposal = null;
    // Synchronous: Chrome's built-in model may need this click's activation.
    if (fromModel) rewrite();
    else void refresh();
  });
  $('diffMode').addEventListener('change', renderProposal);
  const purpose = $<HTMLSelectElement>('purpose');
  purpose.replaceChildren(...PURPOSES.map((p) => new Option(p.label, p.id)));
  // Rules depend on purpose, so the content script re-checks and the panel refreshes on its broadcast.
  purpose.addEventListener('change', () => void updateSettings((s) => ({ ...s, purpose: purpose.value as Purpose })));
  $('thresholdFix').addEventListener('click', () => void updateSettings((s) => ({ ...s, minWords: DEFAULT_SETTINGS.minWords })));

  $('aiAction').addEventListener('click', () => ai.act());
  let pending: number | undefined;
  followActiveTab({
    tab(id) {
      if (id === tabId) return;
      ai.reset();
      job?.abort();
      tabId = id;
      proposal = null;
      result('');
      void refresh();
    },
    loaded: (id) => id === tabId && void refresh(),
    broadcast(msg, from) {
      if (from !== tabId) return;
      if (msg.type === 'analysis/cleared') {
        setSnapshot(msg.reason === 'iframe' ? { state: 'unsupported', reason: 'iframe' } : { state: 'none' });
        return;
      }
      $('scoreNum').closest('.score')?.classList.add('is-checking');
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void refresh(), 60);
    },
  });

  const syncPurpose = () => ($<HTMLSelectElement>('purpose').value = settings.purpose);
  onSettingsChanged((s) => { settings = s; syncPurpose(); void renderEngine(); });
  chrome.storage.onChanged.addListener((_c, area) => area === 'session' && void renderEngine());
  window.addEventListener('focus', () => void renderEngine()); // key saved in Settings (IndexedDB has no change event)
  void loadSettings().then((s) => { settings = s; syncPurpose(); void renderEngine(); });
}

wire();
