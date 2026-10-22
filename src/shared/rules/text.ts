export interface Span {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** Curly quotes → straight, same length so offsets survive. */
export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

export function sentences(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const lead = m[0].length - m[0].trimStart().length;
    const body = m[0].trim();
    if (!body) continue;
    const start = m.index + lead;
    out.push({ start, end: start + body.length, text: body });
  }
  return out;
}

export function paragraphs(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/** Quoted replies (> lines) and "double-quoted" spans are the author citing someone else. */
export function excludedRanges(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/^>.*$/gm)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  for (const m of normalizeQuotes(text).matchAll(/"[^"\n]{1,400}"/g)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

export function overlaps(a: { start: number; end: number }, list: readonly { start: number; end: number }[]): boolean {
  return list.some((b) => a.start < b.end && b.start < a.end);
}

export function isSentenceStart(text: string, index: number): boolean {
  return /(^|[.!?]\s+|\n\s*)$/.test(text.slice(Math.max(0, index - 4), index));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
