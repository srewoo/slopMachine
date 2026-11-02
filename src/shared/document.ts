/**
 * Documents Chrome renders without a page we can read: PDFs (Chrome's viewer is closed to extensions)
 * and Google Docs/Slides (drawn on a canvas). The panel fetches the file itself, on request, and
 * reviews the text read-only. Pure helpers here; fetching and pdf.js live in the side panel.
 */

export type DocTarget =
  | { readonly kind: 'pdf'; readonly url: string; readonly name: string }
  | { readonly kind: 'gdoc' | 'gslides'; readonly url: string; readonly exportUrl: string; readonly name: string };

export const GOOGLE_DOCS_ORIGIN = 'https://docs.google.com/*';
/** Larger files are refused before parsing: a review only reads the first MAX_CHARS anyway. */
export const MAX_PDF_BYTES = 40 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;

const GOOGLE = /^\/(document|presentation)\/(?:u\/\d+\/)?d\/([\w-]{20,})/;

/** What the tab shows, from its URL. Null for anything we don't read this way. */
export function docTarget(rawUrl: string | undefined): DocTarget | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const g = url.hostname === 'docs.google.com' ? GOOGLE.exec(url.pathname) : null;
  if (g) {
    const [, type, id] = g;
    return type === 'document'
      ? { kind: 'gdoc', url: rawUrl, exportUrl: `https://docs.google.com/document/d/${id}/export?format=txt`, name: 'Google Doc' }
      : { kind: 'gslides', url: rawUrl, exportUrl: `https://docs.google.com/presentation/d/${id}/export/txt`, name: 'Google Slides deck' };
  }
  if (/\.pdf$/i.test(url.pathname)) {
    const file = decodeURIComponent(url.pathname.split('/').pop() ?? '') || url.hostname;
    return { kind: 'pdf', url: rawUrl, name: file };
  }
  return null;
}

/** The origin permission a fetch of this target needs. Plain-http PDFs are not supported. */
export function originFor(t: DocTarget): string | null {
  if (t.kind !== 'pdf') return GOOGLE_DOCS_ORIGIN;
  const u = new URL(t.url);
  return u.protocol === 'https:' ? `https://${u.hostname}/*` : null;
}

/** Google's text export: BOM, CRLF, one line per paragraph. Blank-line paragraphs for the rules. */
export function cleanExport(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n\n');
}

/** A text run from pdf.js getTextContent(): `transform[5]` is its baseline y, larger is higher. */
export interface PdfItem {
  readonly str: string;
  readonly transform: readonly number[];
  readonly height: number;
  readonly hasEOL?: boolean;
}

interface Line { text: string; y: number; h: number }

function toLines(items: readonly PdfItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const it of items) {
    if (!('str' in it)) continue; // marked-content entries carry no text
    const y = it.transform[5] ?? 0;
    const h = it.height || Math.abs(it.transform[3] ?? 0) || 10;
    if (cur && it.str && Math.abs(y - cur.y) > h * 0.5) {
      lines.push(cur);
      cur = null;
    }
    if (it.str) {
      if (!cur) cur = { text: '', y, h };
      cur.text += it.str; // pdf.js emits word spaces as their own runs
      cur.h = Math.max(cur.h, h);
    }
    if (it.hasEOL && cur) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}

/**
 * One page of runs → paragraphs. PDFs store visual lines, and the rules split sentences at line
 * breaks, so wrapped lines are joined back up (undoing end-of-line hyphenation) and a paragraph
 * starts only where the gap between lines is clearly bigger than the page's usual line spacing.
 * Bare page numbers are dropped. ponytail: gap heuristic; single-spaced PDFs with no paragraph
 * spacing come out as one paragraph per page (indent detection would fix that).
 */
export function pageText(items: readonly PdfItem[]): string {
  const lines = toLines(items).filter((l) => !/^(?:page )?\d{1,4}(?: of \d{1,4})?$/i.test(l.text));
  if (!lines.length) return '';
  const gaps = lines.slice(1).map((l, i) => lines[i]!.y - l.y).filter((g) => g > 0).sort((a, b) => a - b);
  const usual = gaps[Math.floor(gaps.length / 2)] ?? lines[0]!.h * 1.2;
  let out = lines[0]!.text;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1]!.y - lines[i]!.y;
    const next = lines[i]!.text;
    if (gap > usual * 1.4 || gap < 0) out += `\n\n${next}`;
    else if (/[a-z]-$/.test(out) && /^[a-z]/.test(next)) out = out.slice(0, -1) + next;
    else out += ` ${next}`;
  }
  return out;
}

/** Minimal slice of the pdf.js API we use, so tests can pass the Node build. */
export interface PdfJs {
  getDocument(src: { data: Uint8Array; isEvalSupported: boolean; disableFontFace: boolean; stopAtErrors: boolean }): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: readonly unknown[] }> }> }>;
    destroy(): Promise<void>;
  };
}

export interface PdfResult { readonly text: string; readonly pages: number; readonly readPages: number }

/** Text of the first MAX_PDF_PAGES pages, stopping early once there is more than `maxChars`. */
export async function pdfText(pdfjs: PdfJs, data: Uint8Array, maxChars: number): Promise<PdfResult> {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, stopAtErrors: false });
  try {
    const doc = await task.promise;
    const parts: string[] = [];
    let size = 0;
    let n = 0;
    while (n < Math.min(doc.numPages, MAX_PDF_PAGES) && size <= maxChars) {
      const page = await doc.getPage(++n);
      const t = pageText((await page.getTextContent()).items as PdfItem[]);
      if (t) parts.push(t);
      size += t.length;
    }
    return { text: parts.join('\n\n'), pages: doc.numPages, readPages: n };
  } finally {
    await task.destroy(); // frees the worker's copy of the file
  }
}

export const isPdfBytes = (b: Uint8Array): boolean => b.length > 4 && String.fromCharCode(...b.subarray(0, 5)) === '%PDF-';
