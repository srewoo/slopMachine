import { paragraphs, type Span } from '../rules/text.ts';

/** Words a passage needs before any authorship estimate is shown for it. */
export const MIN_DETECT_WORDS = 50;
const CHUNK_MIN_WORDS = 40;
/** Language-model passes per document; bounds the deep check to roughly 1,000 tokens. */
export const MAX_LM_CHUNKS = 4;

const wc = (s: string) => s.match(/\S+/g)?.length ?? 0;

/** Paragraphs, with short ones (greetings, one-liners) merged into their neighbour. */
export function chunkText(text: string): Span[] {
  const out: Span[] = [];
  let cur: Span | null = null;
  for (const p of paragraphs(text)) {
    cur = cur ? { start: cur.start, end: p.end, text: text.slice(cur.start, p.end) } : p;
    if (wc(cur.text) >= CHUNK_MIN_WORDS) { out.push(cur); cur = null; }
  }
  if (cur) {
    const last = out.pop();
    out.push(last ? { start: last.start, end: cur.end, text: text.slice(last.start, cur.end) } : cur);
  }
  return out;
}
