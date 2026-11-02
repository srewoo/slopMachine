import {
  cleanExport, isPdfBytes, MAX_PDF_BYTES, MAX_PDF_PAGES, originFor, pdfText, type DocTarget, type PdfJs,
} from '../shared/document.ts';
import type { OutlineReply, Request, Snapshot } from '../shared/messages.ts';
import { analyze } from '../shared/rules/engine.ts';
import type { Settings } from '../shared/settings.ts';
import { MAX_CHARS } from '../shared/types.ts';

/** pdf.js is loaded on the first PDF only, so opening the panel stays fast. */
async function loadPdfJs(): Promise<PdfJs> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf/pdf.worker.min.mjs');
  return { getDocument } as unknown as PdfJs;
}

/** A failure worth showing as is. */
export class DocError extends Error {}

/** Read text, the panel's stand-in for a content script: the document never changes and can't be edited. */
export interface LoadedDoc {
  readonly text: string;
  readonly site: string;
  readonly truncated: boolean;
  /** Shown beside the score, e.g. "first 40 of 120 pages". */
  readonly note: string;
}

/**
 * Must be the first thing a click handler calls: Chrome only shows the permission prompt during
 * the click's user activation, which an earlier `await` would use up.
 */
export function requestAccess(t: DocTarget): Promise<boolean> {
  const origin = originFor(t);
  if (!origin) return Promise.reject(new DocError('Only https:// PDFs can be read from a tab. Download it and choose the file instead.'));
  const had = chrome.permissions.contains({ origins: [origin] }); // started alongside, not awaited before the prompt
  const granted = chrome.permissions.request({ origins: [origin] });
  void had.then((h) => (borrowed = !h && t.kind === 'pdf' ? origin : null));
  return granted;
}

/** A PDF's site granted just to read one file; handed back once it is read. Google Docs access stays. */
let borrowed: string | null = null;
async function giveBack(): Promise<void> {
  const origin = borrowed;
  borrowed = null;
  if (origin) await chrome.permissions.remove({ origins: [origin] }).catch(() => undefined);
}

async function readPdf(data: Uint8Array, site: string): Promise<LoadedDoc> {
  if (data.byteLength > MAX_PDF_BYTES) throw new DocError('This PDF is over 40 MB. Split it or copy the part you want checked.');
  if (!isPdfBytes(data)) throw new DocError('This is not a PDF file.');
  let r;
  try {
    r = await pdfText(await loadPdfJs(), data, MAX_CHARS);
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') throw new DocError('This PDF is password-protected. Open it, copy the text and paste it into an editor instead.');
    throw new DocError('This PDF could not be read. It may be damaged.');
  }
  if (!r.text.trim()) throw new DocError('This PDF has no text layer, only images of pages (a scan). SlopMachine can’t read those.');
  const partial = r.readPages < r.pages;
  const capped = r.pages > MAX_PDF_PAGES && r.readPages === MAX_PDF_PAGES;
  const note = partial ? `first ${r.readPages} of ${r.pages} pages${capped ? '' : ' (length limit)'}` : `${r.pages} ${r.pages === 1 ? 'page' : 'pages'}`;
  return { text: r.text, site, truncated: partial || r.text.length > MAX_CHARS, note };
}

/** Fetch with the user's own session, after requestAccess granted the origin. */
export async function loadTarget(t: DocTarget): Promise<LoadedDoc> {
  let res: Response;
  try {
    res = await fetch(t.kind === 'pdf' ? t.url : t.exportUrl, { credentials: 'include', redirect: 'follow' });
  } catch {
    void giveBack();
    throw new DocError('The document could not be downloaded. Check your connection, or that the site still allows access.');
  }
  if (t.kind === 'pdf') {
    void giveBack();
    if (!res.ok) throw new DocError(`The PDF could not be downloaded (HTTP ${res.status}).`);
    const size = Number(res.headers.get('content-length') ?? 0);
    if (size > MAX_PDF_BYTES) throw new DocError('This PDF is over 40 MB. Split it or copy the part you want checked.');
    return readPdf(new Uint8Array(await res.arrayBuffer()), new URL(t.url).hostname);
  }
  // A signed-out or no-access export answers with an HTML sign-in or request-access page, not text.
  if (!res.ok || !/^text\/plain\b/i.test(res.headers.get('content-type') ?? '')) {
    throw new DocError(`Google didn’t hand over this ${t.name}. Make sure you’re signed in to an account that can open it, then try again.`);
  }
  const text = cleanExport(await res.text());
  if (!text.trim()) throw new DocError(`This ${t.name} has no text yet.`);
  return { text, site: 'docs.google.com', truncated: text.length > MAX_CHARS, note: t.name };
}

export async function loadFile(file: File): Promise<LoadedDoc> {
  if (file.size > MAX_PDF_BYTES) throw new DocError('This PDF is over 40 MB. Split it or copy the part you want checked.');
  return readPdf(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** Answers the panel's content-script requests from a loaded document. */
export function createLocalDoc(doc: LoadedDoc, settings: () => Settings) {
  const ignore = new Set<string>();
  let seq = 0;
  const text = doc.text.slice(0, MAX_CHARS);
  const revision = () => `doc:${seq}`;

  function snapshot(): Snapshot {
    const s = settings();
    const analysis = analyze(text, s, undefined, ignore);
    return {
      state: 'ready', mode: 'page', editorId: 'doc', revision: revision(), site: doc.site, text, truncated: doc.truncated,
      eligible: analysis.wordCount >= s.minWords, minWords: s.minWords, canApply: false, analysis,
    };
  }

  function handle(msg: Request): unknown {
    switch (msg.type) {
      case 'snapshot/get':
      case 'page/review':
        return snapshot();
      case 'page/outline':
        if (msg.revision !== revision()) return { ok: false };
        return { ok: true, outline: `Document: ${doc.note}\n\n${text.slice(0, msg.max)}`, truncated: text.length > msg.max || doc.truncated } satisfies OutlineReply;
      case 'dismiss':
        ignore.add(msg.key);
        seq++;
        return { ok: true };
      case 'reveal':
        return { ok: false }; // nothing on screen we can select
      case 'apply':
        return { ok: false, reason: 'unsupported' };
    }
  }

  return { handle, note: doc.note };
}
export type LocalDoc = ReturnType<typeof createLocalDoc>;
