// Which rows train what. One source of truth for train.ts, prepare_ft.ts and the report.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Row } from './fit.ts';

export type Pick = (r: Row) => boolean;

export const textId = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16);

const all: Pick = () => true;
// Deterministic splits by content hash, so reruns and new rows never shuffle what was held out.
export const trainHalf: Pick = (r) => parseInt(r.id.slice(4, 8), 16) % 2 === 0;
/** Split A (70%) fine-tunes the bundled model; split B trains the ensemble on top of it. */
export const fineTuneSplit: Pick = (r) => parseInt(r.id.slice(8, 12), 16) % 10 < 7;

/**
 * Training sources and which of their rows train. The Liang et al. essays carry no license and HC3
 * is share-alike, so both are evaluation-only. RAID's books are AI-only in this sample; without
 * human books they would teach "book prose means AI".
 */
export const TRAIN: readonly [string, Pick][] = [
  ['mage-train', all], ['raid-train', (r) => !r.meta!.includes('/books/')], ['enron', trainHalf],
  ['domain-ai-train', all], ['humanlike-train', all], ['modern-train', all], ['ell-train', all], ['unix-train', all],
  ['longform-train', all], ['essays-train', all],
];

export const EVAL: readonly [string, string, Pick][] = [
  ['modern-eval', 'modern AI (2025 chatbots)', all],
  ['domain-ai', 'Claude business writing', all],
  ['enron', 'business email (people)', (r) => !trainHalf(r)],
  ['ell-eval', 'English learners (people)', all],
  ['unix-eval', 'technical answers (people)', all],
  ['mage-test', 'mage-test', all],
  ['hc3', 'hc3', all],
  ['raid-adversarial', 'raid-adversarial', all],
  ['essays-eval', 'student essays (ELLIPSE, PERSUADE, AI)', all],
  ['liang-nonnative', 'liang-nonnative', all],
];

/** Raw rows of a set, with ids. */
export async function loadRaw(set: string): Promise<(Row & { text: string })[]> {
  const lines = (await readFile(`.cache/detector/raw/${set}.jsonl`, 'utf8')).trim().split('\n');
  return lines.map((l) => {
    const r = JSON.parse(l);
    return { ...r, id: textId(r.text), features: {} };
  });
}

/** Genre of a row, so weights and folds work per genre and pair human and AI text of the same kind. */
export function genre(r: Row): string {
  const m = r.meta ?? '';
  const purpose = (p: string | undefined) => (p === 'outreach' || p === 'email' ? 'email' : p === 'docs' ? 'docs' : p === 'essay' ? 'essay' : 'post');
  switch (r.source) {
    case 'mage': return `mage/${m.split('_')[0]}`;
    case 'raid': return `raid/${m.split('/')[1]}`;
    case 'enron': return 'email';
    case 'ell': return 'learner';
    case 'unix': return 'docs';
    case 'ellipse': case 'persuade': case 'claude-essay': return 'school';
    case 'claude-domain-train': case 'claude-humanlike': case 'claude-domain': return purpose(m.split('/')[1]);
    case 'arena': case 'wildchat': { const g = m.split('/')[1]!; return g === 'marketing' ? 'post' : g; }
    default: return r.source;
  }
}
/**
 * Writing family for balancing the fine-tune: every family carries equal human and AI weight, so no
 * kind of writing can be learned as "the AI kind". Essays, stories and articles pair with MAGE's and
 * RAID's human long-form text.
 */
export function family(g: string): string {
  if (g === 'email' || g === 'docs' || g === 'learner' || g === 'school') return g;
  if (g === 'post' || g === 'mage/eli5' || g === 'mage/yelp' || g === 'mage/tldr' || g === 'mage/cmv') return 'post';
  return 'longform'; // essay, other, humanize, and the remaining MAGE and RAID genres
}
