import { analyze } from '../shared/rules/engine.ts';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings.ts';
import { siteMatches } from '../shared/sites.ts';
import { MAX_CHARS, type Analysis } from '../shared/types.ts';
import type { Broadcast, Snapshot } from '../shared/messages.ts';
import type { Adapter, Editor } from './adapters.ts';
import { extractText } from './apply.ts';
import { pageRoot, readPage } from './page.ts';

/** Everything we know about the one focused editor. Draft text lives only here, in memory. */
interface Attached {
  readonly el: Editor;
  readonly editorId: string;
  readonly href: string;
  seq: number;
  text: string;
  analysis: Analysis;
  largestPaste: number;
  editedSincePaste: number;
  readonly ignore: Set<string>;
}

declare const __E2E__: boolean;

/** crypto.randomUUID needs a secure page; getRandomValues works on any page a content script runs on. */
const newId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

let current: Attached | null = null;
/** A page review the user asked for. Read-only; an editor taking focus replaces it. */
interface PageReview {
  readonly root: HTMLElement;
  readonly id: string;
  readonly href: string;
  seq: number;
  text: string;
  analysis: Analysis;
  readonly ignore: Set<string>;
}
let page: PageReview | null = null;
/** False until settings load, and whenever the user turns this site off: then we read nothing. */
let enabled = false;
/** Set when focus went into a frame we are not running in; its host, so the panel can name it. */
let unsupported: { host: string } | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let adapter: Adapter;

export function init(a: Adapter): void {
  adapter = a;
}

export const getCurrent = (): Attached | null => current;
export const revisionOf = (a: Attached): string => `${a.editorId}:${a.seq}`;

function send(msg: Broadcast): void {
  if (!chrome.runtime?.id) return; // extension reloaded; this script is orphaned
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function eligible(a: Attached): boolean {
  return a.analysis.wordCount >= settings.minWords;
}

/** Re-read the editor; bump the revision only when the text actually changed. */
export function refresh(a: Attached, force = false): boolean {
  const text = extractText(a.el, adapter.exclude).slice(0, MAX_CHARS + 1);
  const changed = text !== a.text;
  if (!changed && !force) return false;
  if (changed) a.seq += 1;
  a.text = text;
  a.analysis = analyze(
    text.slice(0, MAX_CHARS),
    settings,
    { largestPasteChars: a.largestPaste, editedCharsSincePaste: a.editedSincePaste },
    a.ignore,
  );
  const { score, status, wordCount } = a.analysis;
  send({ v: 1, type: 'analysis/updated', editorId: a.editorId, revision: revisionOf(a), score, status, wordCount, eligible: eligible(a) });
  return changed;
}

export function attach(el: Editor): void {
  if (!enabled || current?.el === el) return;
  unsupported = null;
  page = null;
  current = {
    el, editorId: newId(), href: location.href, seq: 0, text: '\u0000',
    analysis: analyze('', settings), largestPaste: 0, editedSincePaste: 0, ignore: new Set(),
  };
  refresh(current);
}

/** This frame took focus: tell the panel, only if this site is on. Carries no text. */
export function announceFrame(): void {
  if (enabled && window.top !== window) send({ v: 1, type: 'frame/active' });
}

export function detach(reason: 'navigate' | 'removed' | 'blurred' | 'iframe', frameHost = ''): void {
  if (reason === 'navigate' || reason === 'removed') {
    const hadPage = !!page;
    page = null;
    if (hadPage && !current) return send({ v: 1, type: 'analysis/cleared', reason });
  }
  if (!current && reason !== 'iframe') return;
  current = null;
  unsupported = reason === 'iframe' ? { host: frameHost } : null;
  send({ v: 1, type: 'analysis/cleared', reason });
}

function siteEnabled(s: Settings): boolean {
  if (__E2E__) return true; // test build only; compiled out of release bundles
  if (adapter.id === 'gmail' || adapter.id === 'linkedin') return s.sites[adapter.id];
  return s.genericOrigins.some((p) => siteMatches(p, location.hostname));
}

export function setSettings(next: Settings): void {
  settings = next;
  enabled = siteEnabled(next);
  if (!enabled) detach('removed');
  else if (current) refresh(current, true);
  else if (page) refreshPage(page, true);
}

export function notePaste(chars: number): void {
  if (!current || chars <= current.largestPaste) return;
  current.largestPaste = chars;
  current.editedSincePaste = 0;
}

export function noteEdit(chars: number): void {
  if (current?.largestPaste) current.editedSincePaste += chars;
}

export function dismiss(key: string): void {
  if (current) {
    current.ignore.add(key);
    refresh(current, true);
  } else if (page) {
    page.ignore.add(key);
    refreshPage(page, true);
  }
}

export const getPage = (): PageReview | null => page;
export const pageRevision = (p: PageReview): string => `${p.id}:${p.seq}`;

/** Re-read the page; bump the revision only when its text changed. */
export function refreshPage(p: PageReview, force = false): boolean {
  const text = readPage(p.root).text.slice(0, MAX_CHARS + 1);
  const changed = text !== p.text;
  if (!changed && !force) return false;
  if (changed) p.seq += 1;
  p.text = text;
  p.analysis = analyze(text.slice(0, MAX_CHARS), settings, undefined, p.ignore);
  const { score, status, wordCount } = p.analysis;
  send({ v: 1, type: 'analysis/updated', editorId: p.id, revision: pageRevision(p), score, status, wordCount, eligible: wordCount >= settings.minWords });
  return changed;
}

/** Starts a page review. Only ever called because the user pressed "Review this page". */
export function reviewPage(): void {
  if (!enabled || current) return;
  const root = pageRoot();
  page = { root, id: newId(), href: location.href, seq: 0, text: '\u0000', analysis: analyze('', settings), ignore: new Set() };
  refreshPage(page);
}

export function snapshot(): Snapshot {
  if (!enabled) return { state: 'none' };
  if (unsupported) return { state: 'unsupported', reason: 'iframe', ...(unsupported.host && { host: unsupported.host }) };
  if (!current && page?.root.isConnected) {
    const p = page;
    refreshPage(p);
    return {
      state: 'ready', mode: 'page', editorId: p.id, revision: pageRevision(p), site: location.hostname,
      text: p.text.slice(0, MAX_CHARS), truncated: p.text.length > MAX_CHARS,
      eligible: p.analysis.wordCount >= settings.minWords, minWords: settings.minWords, canApply: false, analysis: p.analysis,
    };
  }
  if (!current || !current.el.isConnected) return { state: 'none' };
  refresh(current);
  const a = current;
  return {
    state: 'ready',
    mode: 'editor',
    editorId: a.editorId,
    revision: revisionOf(a),
    site: adapter.id === 'generic' ? location.hostname : adapter.label,
    text: a.text.slice(0, MAX_CHARS),
    truncated: a.text.length > MAX_CHARS,
    eligible: eligible(a),
    minWords: settings.minWords,
    canApply: true,
    analysis: a.analysis,
  };
}
