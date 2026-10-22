import { RequestSchema, type ApplyResult, type OutlineReply } from '../shared/messages.ts';
import { loadSettings, onSettingsChanged } from '../shared/settings.ts';
import { adapterFor } from './adapters.ts';
import { replaceRange, select } from './apply.ts';
import { buildOutline } from './outline.ts';
import { revealOnPage } from './page.ts';
import * as session from './session.ts';

const FLAG = '__slopMachineLoaded';
const g = globalThis as unknown as Record<string, boolean>;

if (!g[FLAG] && window.top === window) {
  g[FLAG] = true;
  start();
}

function start(): void {
  const adapter = adapterFor(location.hostname);
  session.init(adapter);
  onSettingsChanged(session.setSettings);

  let timer: number | undefined;
  let composing = false;
  const schedule = () => {
    window.clearTimeout(timer);
    if (composing) return;
    timer = window.setTimeout(() => {
      const c = session.getCurrent();
      if (c) session.refresh(c);
    }, 200);
  };
  const inEditor = (e: Event) => {
    const c = session.getCurrent();
    return !!c && e.composedPath().includes(c.el);
  };

  const onFocus = (target: Element | null) => {
    if (!target) return;
    if (target instanceof HTMLIFrameElement) return session.detach('iframe');
    const editor = adapter.resolve(target);
    if (editor) session.attach(editor);
  };

  document.addEventListener('focusin', (e) => onFocus(e.composedPath()[0] as Element | null), true);
  // Settings load after the script starts: pick up an editor that already had focus by then
  // (e.g. the site was just turned on with a compose window open).
  void loadSettings().then((s) => {
    session.setSettings(s);
    onFocus(document.activeElement);
  });
  // Focus entering an iframe fires no focusin here; the parent window just blurs.
  window.addEventListener('blur', () => window.setTimeout(() => {
    if (document.activeElement instanceof HTMLIFrameElement) session.detach('iframe');
  }, 0));

  // Focus moving to another element in this page clears the draft. The window losing focus
  // (e.g. the user clicking into the side panel) does not: activeElement stays the editor.
  document.addEventListener('focusout', () => {
    window.setTimeout(() => {
      const c = session.getCurrent();
      if (!c) return;
      const active = document.activeElement;
      if (active && (active === c.el || c.el.contains(active))) return;
      if (active && active !== document.body) onFocus(active);
      if (session.getCurrent() === c) session.detach('blurred');
    }, 300);
  }, true);

  document.addEventListener('input', (e) => inEditor(e) && schedule(), true);
  document.addEventListener('compositionstart', (e) => { if (inEditor(e)) composing = true; }, true);
  document.addEventListener('compositionend', (e) => { if (inEditor(e)) { composing = false; schedule(); } }, true);
  document.addEventListener('paste', (e) => {
    if (inEditor(e)) session.notePaste(e.clipboardData?.getData('text/plain').length ?? 0);
  }, true);
  document.addEventListener('beforeinput', (e) => {
    if (inEditor(e) && e.inputType !== 'insertFromPaste') session.noteEdit(e.data?.length || 1);
  }, true);

  // Rich editors change without input events (templates, host autocompletion).
  const observer = new MutationObserver(schedule);
  let observed: Element | null = null;
  window.setInterval(() => {
    const c = session.getCurrent();
    if (c && !c.el.isConnected) session.detach('removed');
    else if (c && location.href !== c.href) session.detach('navigate');
    const p = session.getPage();
    if (p && (location.href !== p.href || !p.root.isConnected)) session.detach('navigate');
    const el = session.getCurrent()?.el ?? null;
    if (el !== observed) {
      observer.disconnect();
      if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
      observed = el;
    }
  }, 250); // ponytail: polling for SPA nav/removal; navigation API listener when it ships everywhere

  window.addEventListener('pagehide', () => session.detach('navigate'));

  chrome.runtime.onMessage.addListener((raw, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    const parsed = RequestSchema.safeParse(raw);
    if (!parsed.success) return false;
    const msg = parsed.data;

    if (msg.type === 'snapshot/get') reply(session.snapshot());
    else if (msg.type === 'page/review') { session.reviewPage(); reply(session.snapshot()); }
    else if (msg.type === 'page/outline') {
      // Only for the page under review, and only while its text is the version the panel has.
      const p = session.getPage();
      if (!p || session.getCurrent() || session.refreshPage(p) || session.pageRevision(p) !== msg.revision) reply({ ok: false });
      else {
        const o = buildOutline(p.root, document.title, msg.max);
        reply({ ok: true, outline: o.text, truncated: o.truncated } satisfies OutlineReply);
      }
    }
    else if (msg.type === 'dismiss') { session.dismiss(msg.key); reply({ ok: true }); }
    else if (session.snapshot().state !== 'ready') reply({ ok: false, reason: 'unsupported' } satisfies ApplyResult);
    else if (!session.getCurrent() && session.getPage()) {
      // Page review is read-only: reveal only, and only if the page text is unchanged.
      const p = session.getPage()!;
      if (msg.type !== 'reveal') reply({ ok: false, reason: 'unsupported' } satisfies ApplyResult);
      else if (session.refreshPage(p) || session.pageRevision(p) !== msg.revision) reply({ ok: false });
      else reply({ ok: revealOnPage(p.root, msg.start, msg.end) });
    } else {
      const c = session.getCurrent();
      // The panel's revision must match the live editor right now, or we touch nothing.
      if (!c || !c.el.isConnected) reply({ ok: false, reason: 'unsupported' } satisfies ApplyResult);
      else if (session.refresh(c) || session.revisionOf(c) !== msg.revision || msg.end > c.text.length) {
        reply({ ok: false, reason: 'stale' } satisfies ApplyResult);
      } else if (msg.type === 'reveal') {
        reply({ ok: select(c.el, msg.start, msg.end, adapter.exclude) });
      } else {
        const result = replaceRange(c.el, msg.start, msg.end, msg.replacement, adapter.exclude);
        session.refresh(c);
        reply(result === 'ok' ? { ok: true, revision: session.revisionOf(c) } : { ok: false, reason: result });
      }
    }
    return false;
  });
}
