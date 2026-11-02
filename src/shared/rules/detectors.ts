import { INVISIBLE_RE, MIXED_SCRIPT_RE, unmask } from '../detect/normalize.ts';
import type { EditSignals, Family, Fix, RuleSettings, Severity } from '../types.ts';
import { fragmentRows, TELLS, tellFix } from './humanizer.ts';
import { DEFAULT_PHRASES, type PhraseEntry } from './phrases.ts';
import {
  capitalize, countWords, escapeRegExp, excludedRanges, isSentenceStart, normalizeQuotes, overlaps, paragraphs, sentences,
} from './text.ts';

export interface Candidate {
  readonly ruleId: string;
  readonly family: Family;
  readonly severity: Severity;
  readonly start: number;
  readonly end: number;
  readonly match: string;
  readonly title: string;
  readonly message: string;
  readonly base: number;
  readonly fix?: Fix;
  readonly weak?: boolean;
  readonly minHits?: number;
}

type Detector = (text: string, s: RuleSettings, sig: EditSignals) => Candidate[];

const PLACEHOLDER = /\{\{\s*[^{}\n]{1,40}?\s*\}\}|\{[A-Za-z_][\w.]{0,30}\}|\[(?:[A-Z][^\]\n]{0,80})\](?!\()|\*\|[A-Z_]+\|\*|%[A-Z_]{3,}%|<(?:first[_ ]?name|last[_ ]?name|company|name)>|\b(?:INSERT|TODO|TBD|FIXME|XXX)\b/g;

const placeholders: Detector = (text) =>
  [...text.matchAll(PLACEHOLDER)].map((m) => ({
    ruleId: 'placeholder',
    family: 'placeholder',
    severity: 'critical',
    start: m.index,
    end: m.index + m[0].length,
    match: m[0],
    title: m[0].length <= 24 ? `Fill in ${m[0]}` : 'Fill in the template note',
    message: 'This looks like an unfinished template. Fill it in before it goes out.',
    base: 20,
  }));

/** Cut [start,end) plus trailing punctuation/space; recapitalize the next word if it now opens a sentence. */
export function removalFix(text: string, start: number, end: number, label = 'Cut it'): Fix {
  let stop = end + (text.slice(end).match(/^[,;:]?[ \t]*/)?.[0].length ?? 0);
  let replacement = '';
  const next = text.charAt(stop);
  if (isSentenceStart(text, start) && /[a-z]/.test(next)) {
    replacement = next.toUpperCase();
    stop += 1;
  }
  return { label, replacement, start, end: stop };
}

function phraseFix(text: string, start: number, end: number, entry: PhraseEntry): Fix | undefined {
  if (entry.swap === undefined) return undefined;
  if (entry.swap === '') return removalFix(text, start, end);
  const original = text.slice(start, end);
  const swap = /^[A-Z]/.test(original) ? capitalize(entry.swap) : entry.swap;
  return { label: `Use “${swap}”`, replacement: swap, start, end };
}

const stockPhrases: Detector = (text, s) => {
  const allowed = new Set(s.allowList.map((p) => normalizeQuotes(p).toLowerCase().trim()));
  const purpose = s.purpose ?? 'outreach';
  const entries: PhraseEntry[] = [...DEFAULT_PHRASES.filter((e) => !e.only || e.only.includes(purpose)), ...s.customPhrases.map((phrase) => ({ phrase }))]
    .filter((e) => e.phrase.trim() && !allowed.has(normalizeQuotes(e.phrase).toLowerCase().trim()))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  const hay = normalizeQuotes(text);
  const phraseRe = (p: string) => new RegExp(`(?<![\\w-])${escapeRegExp(normalizeQuotes(p.trim()))}(?![\\w-])`, 'gi');
  // Allow-listed occurrences block shorter entries inside them ("delve into" allowed → "delve" silent there).
  const taken = [...excludedRanges(text), ...[...allowed].filter(Boolean).flatMap((p) =>
    [...hay.matchAll(phraseRe(p))].map((m) => ({ start: m.index, end: m.index + m[0].length })))];
  const out: Candidate[] = [];
  for (const entry of entries) {
    for (const m of hay.matchAll(phraseRe(entry.phrase))) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(span, taken)) continue;
      taken.push(span);
      const fix = phraseFix(text, span.start, span.end, entry);
      out.push({
        ruleId: 'phrase',
        family: 'generic',
        severity: 'warning',
        ...span,
        match: text.slice(span.start, span.end),
        title: 'Swap a stock phrase for something specific',
        message: 'This phrase may sound generic. A concrete detail about the reader works better.',
        base: 6,
        ...(fix ? { fix } : {}),
      });
    }
  }
  return out;
};

const SOURCE_CUE = /\b(according to|source|per |study|report|survey|data from|measured|case study)|https?:\/\//i;
/** A goal or threshold, not a result: "at least 80% rated useful", "keep errors under 2%". */
const TARGET_CUE = /\b(?:at least|at most|no more than|no less than|under|below|target(?:s|ed)?|goal|aim(?:s|ing)? (?:for|to)|threshold|SLA|KPI|success criteria)\b|[<>≤≥]/i;

const numericClaims: Detector = (text) => {
  const out: Candidate[] = [];
  for (const sentence of sentences(text)) {
    if (SOURCE_CUE.test(sentence.text) || TARGET_CUE.test(sentence.text)) continue;
    for (const m of sentence.text.matchAll(/(?<![\w.])\d+(?:[.,]\d+)?\s?(?:%|percent\b|x\b)/gi)) {
      out.push({
        ruleId: 'numeric-claim',
        family: 'specificity',
        severity: 'warning',
        start: sentence.start + m.index,
        end: sentence.start + m.index + m[0].length,
        match: m[0],
        title: `Add a source for ${m[0]} or cut it`,
        message: 'The claimed result has no source or concrete context.',
        base: 10,
      });
    }
  }
  return out;
};

const VAGUE_CTA = /\b(let'?s connect|let me know if you'?re interested|would love to (?:chat|connect|hop on a call)|pick your brain|touch base|circle back|hop on a (?:quick )?call|arrange a brief introductory call)\b/gi;

// An ask only matters where the text is trying to get a reply or a click.
const vagueCta: Detector = (text, s) => (s.purpose === 'content' || s.purpose === 'docs') ? [] :
  [...normalizeQuotes(text).matchAll(VAGUE_CTA)].map((m) => ({
    ruleId: 'vague-cta',
    family: 'specificity',
    severity: 'warning',
    start: m.index,
    end: m.index + m[0].length,
    match: text.slice(m.index, m.index + m[0].length),
    title: 'Make the ask specific',
    message: 'Name a time, a length, or the one question you want answered.',
    base: 6,
  }));

const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b/i;
const OPENER = /^(i hope (this|you|all)|hope (you|this|all)|i wanted to (reach|touch) |i'?m reaching out|i am reaching out|my name is|i know you'?re busy|i know you are busy|in this (article|post|blog post|guide),? (we|i)( will|'ll)|welcome to (this|our|my) (article|post|guide|blog))/i;

const emptyOpener: Detector = (text) => {
  const first = sentences(text).find((s) => !GREETING.test(s.text));
  if (!first || !OPENER.test(normalizeQuotes(first.text))) return [];
  const trailing = text.slice(first.end).match(/^\s*/)?.[0].length ?? 0;
  return [{
    ruleId: 'opener',
    family: 'specificity',
    severity: 'warning',
    start: first.start,
    end: first.end,
    match: first.text,
    title: 'Cut the warm-up line',
    message: 'The first sentence is a warm-up. Start with the point, or with why it matters to the reader.',
    base: 6,
    fix: { label: 'Remove opener', replacement: '', start: first.start, end: first.end + trailing },
  }];
};

const structure: Detector = (text) => {
  const out: Candidate[] = [];
  const list = sentences(text).filter((s) => countWords(s.text) >= 3);
  const firstWord = (t: string) => t.split(/\s+/)[0]?.toLowerCase().replace(/[^\w']/g, '') ?? '';

  for (let i = 0; i < list.length;) {
    let j = i;
    while (j + 1 < list.length && firstWord(list[j + 1]!.text) === firstWord(list[i]!.text)) j++;
    if (j - i + 1 >= 3) {
      const word = list[i]!.text.split(/\s+/)[0] ?? '';
      out.push({
        ruleId: 'repeated-opening', family: 'structure', severity: 'info',
        start: list[i]!.start, end: list[j]!.end, match: word,
        title: `${j - i + 1} sentences in a row start with “${word}”`,
        message: 'Several adjacent sentences use the same opening. Vary one or two.', base: 5,
      });
    }
    i = j + 1;
  }

  for (let i = 0; i + 3 < list.length; i++) {
    const lens = list.slice(i, i + 4).map((s) => countWords(s.text));
    if (Math.min(...lens) >= 10 && Math.max(...lens) - Math.min(...lens) <= 3) {
      out.push({
        ruleId: 'uniform-length', family: 'structure', severity: 'info',
        start: list[i]!.start, end: list[i + 3]!.end, match: '',
        title: 'Four sentences in a row have the same length',
        message: 'Several adjacent sentences use the same rhythm. A short one breaks it up.', base: 5,
      });
      break;
    }
  }

  for (const p of paragraphs(text)) {
    if (countWords(p.text) > 120) {
      out.push({
        ruleId: 'wall-of-text', family: 'structure', severity: 'info', start: p.start, end: p.end, match: '',
        title: 'Break up this paragraph', message: 'More than 120 words without a break is hard to scan.', base: 5,
      });
    }
  }

  const bullets = [...text.matchAll(/^\s*(?:[-*•]|\d+[.)])\s+/gm)];
  if (bullets.length > 8) {
    out.push({
      ruleId: 'bullets', family: 'structure', severity: 'info', start: bullets[0]!.index, end: bullets[0]!.index,
      match: '', title: `${bullets.length} bullet points`, message: 'Long lists read like a brochure. Keep the three that matter.', base: 4,
    });
  }
  return out;
};

const pasteIndicator: Detector = (text, _s, sig) => {
  const pasted = sig.largestPasteChars;
  if (pasted < text.length * 0.6 || countWords(text) < 25 || sig.editedCharsSincePaste >= pasted * 0.05) return [];
  return [{
    ruleId: 'paste', family: 'paste', severity: 'info', start: 0, end: 0, match: '',
    title: 'Pasted and not edited yet',
    message: 'Most of this draft arrived in one paste with no changes since. Read it once before it goes out.', base: 10,
  }];
};

const humanizerTells: Detector = (text, s) => {
  const purpose = s.purpose ?? 'outreach';
  const hay = normalizeQuotes(text);
  const excluded = excludedRanges(text);
  const out: Candidate[] = [];
  const takenByRule = new Map<string, { start: number; end: number }[]>();
  for (const p of TELLS) {
    if (p.only && !p.only.includes(purpose)) continue;
    const taken = takenByRule.get(p.ruleId) ?? [];
    takenByRule.set(p.ruleId, taken);
    for (const m of hay.matchAll(p.re)) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (!m[0].trim() || overlaps(span, excluded) || overlaps(span, taken)) continue;
      taken.push(span);
      const fix = tellFix(p, text, span.start, span.end);
      out.push({
        ruleId: p.ruleId, family: p.family, severity: p.severity, ...span, match: text.slice(span.start, span.end).trim(),
        title: p.title, message: p.message, base: p.base,
        ...(p.weak ? { weak: true } : {}), ...(p.minHits ? { minHits: p.minHits } : {}), ...(fix ? { fix } : {}),
      });
    }
  }
  for (const span of fragmentRows(text)) {
    out.push({
      ruleId: 'closer', family: 'staging', severity: 'warning', ...span, match: text.slice(span.start, span.end),
      title: 'Merge the row of fragments', message: 'Several tiny sentences in a row for drama. Say it in one sentence with the actual claim.', base: 8,
    });
  }
  return out;
};

/** Zero-width characters and look-alike letters: invisible to readers, used to slip past detectors. One issue, one fix. */
const hiddenChars: Detector = (text) => {
  const hits = [...text.matchAll(INVISIBLE_RE), ...text.matchAll(MIXED_SCRIPT_RE)].map((m) => m.index).sort((a, b) => a - b);
  if (!hits.length) return [];
  const start = hits[0]!;
  const end = hits[hits.length - 1]! + 1;
  return [{
    ruleId: 'hidden-chars', family: 'leftovers', severity: 'warning', start, end, match: '',
    title: `Remove ${hits.length} hidden or look-alike ${hits.length === 1 ? 'character' : 'characters'}`,
    message: 'Zero-width characters or letters from another alphabet that look Latin. They are a known way to fool AI detectors and can break search and copy-paste.',
    base: 10,
    fix: { label: 'Clean them up', replacement: unmask(text.slice(start, end)), start, end },
  }];
};

/**
 * The same short labels opening line after line ("What it does: … Why it's critical: …"), a layout
 * chat models reach for. Plain-text twin of humanizer's bold-labels rule: pages and pasted text lose the bold.
 */
const labelTemplate: Detector = (text) => {
  const lines = [...text.matchAll(/^[ \t]*(?:[-*•]\s*)?(?:\*\*)?([A-Z][\w'’ ]{1,28}?):(?:\*\*)?[ \t]+\S/gm)];
  const counts = new Map<string, number>();
  for (const m of lines) counts.set(m[1]!.toLowerCase(), (counts.get(m[1]!.toLowerCase()) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n >= 2);
  if (repeated.length < 2 || !repeated.some(([, n]) => n >= 3)) return [];
  const first = lines.find((m) => repeated.some(([l]) => l === m[1]!.toLowerCase()))!;
  const names = repeated.slice(0, 2).map(([l]) => `“${lines.find((m) => m[1]!.toLowerCase() === l)![1]}:”`).join(' and ');
  return [{
    ruleId: 'label-template', family: 'structure', severity: 'info', start: first.index, end: first.index + first[0].length - 1, match: '',
    title: `The same labels repeat (${names})`,
    message: 'Line after line opens with the same label. Write the point as a sentence, or keep labels only where a reader scans for them.',
    base: 4,
  }];
};

/**
 * Stand-in names writers rotate for one thing, grouped so that "the dashboard… the API…" (different
 * things) stays quiet. ponytail: fixed lists; the AI review catches open-ended cases.
 */
const CYCLE_GROUPS: Readonly<Record<string, string>> = Object.fromEntries([
  // AI copy swaps "agent", "assistant" and "tool" for one product, so actors and products share a group.
  ['product', 'agent assistant copilot bot chatbot model ai tool platform app application solution system product software service engine offering suite hub'],
  ['company', 'company firm business organization organisation team vendor provider'],
  ['customer', 'customer client user buyer account'],
].flatMap(([group, words]) => words!.split(' ').map((w) => [w, group!])));
const CYCLE_NOUN = new RegExp(`^(?:the|this|our|your|its|their) (${Object.keys(CYCLE_GROUPS).join('|')})\\b`, 'i');

const synonymCycling: Detector = (text) => {
  const out: Candidate[] = [];
  for (const p of paragraphs(text)) {
    const list = sentences(p.text);
    for (let i = 0; i < list.length;) {
      const names: string[] = [];
      let j = i;
      while (j < list.length) {
        const noun = CYCLE_NOUN.exec(list[j]!.text)?.[1]?.toLowerCase();
        if (!noun) break;
        names.push(noun);
        j++;
      }
      // Distinct names within the largest same-group set.
      const byGroup = new Map<string, Set<string>>();
      for (const name of names) byGroup.set(CYCLE_GROUPS[name]!, (byGroup.get(CYCLE_GROUPS[name]!) ?? new Set()).add(name));
      const distinct = [...[...byGroup.values()].reduce((a, b) => (b.size > a.size ? b : a), new Set<string>())];
      if (distinct.length >= 2) {
        out.push({
          ruleId: 'synonym-cycling', family: 'structure', severity: 'info',
          start: p.start + list[i]!.start, end: p.start + list[j - 1]!.end, match: '',
          title: `One thing, ${distinct.length} names (${distinct.map((n) => `“${n}”`).join(', ')})`,
          message: 'Rotating names for the same thing makes the reader wonder if they are different things. Pick one and repeat it, or merge the sentences.',
          base: 5,
          ...(distinct.length < 3 ? { weak: true } : {}),
        });
      }
      i = Math.max(j, i + 1);
    }
  }
  return out;
};

export const DETECTORS: readonly Detector[] = [placeholders, stockPhrases, numericClaims, vagueCta, emptyOpener, structure, pasteIndicator, humanizerTells, hiddenChars, labelTemplate, synonymCycling];

export const RULES: readonly { readonly id: string; readonly label: string; readonly example: string }[] = [
  { id: 'placeholder', label: 'Unfilled merge tags and template notes', example: 'Catches {{first_name}}, [Company] and INSERT notes.' },
  { id: 'phrase', label: 'Stock phrases', example: 'Lines like “in today’s fast-paced landscape” or “cutting-edge”. In docs, also “simply” and “easily”.' },
  { id: 'numeric-claim', label: 'Numbers without a source', example: '“43% more pipeline” with nothing to back it.' },
  { id: 'vague-cta', label: 'Vague call to action', example: '“Let’s connect!” instead of a time or a question. Sales and marketing only.' },
  { id: 'opener', label: 'Empty opening line', example: '“I hope this email finds you well.” or “In this article, we will…”' },
  { id: 'repeated-opening', label: 'Repeated sentence openings', example: 'Three or more sentences in a row that start with the same word.' },
  { id: 'uniform-length', label: 'Same-length sentences', example: 'Four long sentences in a row of nearly equal length.' },
  { id: 'wall-of-text', label: 'Long paragraphs', example: 'More than 120 words without a break.' },
  { id: 'bullets', label: 'Too many bullet points', example: 'More than eight list items.' },
  { id: 'chat-residue', label: 'Chatbot leftovers', example: '“Great question!”, “Here is a revised version”, “I hope this helps”. The last kind is skipped for sales emails.' },
  { id: 'knowledge-limit', label: 'Knowledge-limit disclaimers', example: '“Based on available information…”, “it is believed that…”' },
  { id: 'not-x-but-y', label: '“Not X, but Y” contrasts', example: '“It’s not just a tool, it’s a mindset.”' },
  { id: 'closer', label: 'Dramatic closers and fragments', example: '“Let that sink in.”, “That is the real win.”, “No fuss. No setup. Just results.”' },
  { id: 'deep-saying', label: 'Sayings that sound deep', example: '“At its core, what really matters is…”' },
  { id: 'run-up', label: 'Staged run-ups', example: '“Here’s the thing:”, “Let’s dive in.”, “Honestly?”' },
  { id: 'faux-insight', label: 'Faux-insight setups', example: '“What nobody tells you…”, “The part everyone misses:”' },
  { id: 'colon-reveal', label: 'Colon reveals', example: '“The best part: it learns.” Sales, marketing and posts only.' },
  { id: 'rhetorical-setup', label: 'Rhetorical setups', example: '“What if I told you…”, “Plot twist:”, “The result? It doubled.”' },
  { id: 'synonym-cycling', label: 'One thing, many names', example: '“The agent reads mail. The assistant drafts replies.” Two names only count alongside other tells.' },
  { id: 'strawman', label: 'Arguing with no one', example: '“I’m not saying X, but…”, “To be clear,”' },
  { id: 'ing-rider', label: '“…, highlighting X” tails', example: '“The office opened in 2019, underscoring its commitment to growth.”' },
  { id: 'borrowed-authority', label: 'Unnamed authorities', example: '“Experts believe…”, “Studies show…” with no source.' },
  { id: 'vague-link', label: 'Vague connections', example: '“He is associated with the project.” Only counts alongside other tells.' },
  { id: 'triads', label: 'Lists of three everywhere', example: 'Only when it keeps happening.' },
  { id: 'dashes', label: 'Dashes as the universal connector', example: 'Only when there are several.' },
  { id: 'qualifiers', label: 'Stacked hedges', example: '“could potentially”, “might arguably”' },
  { id: 'hyphen-pair', label: 'Hyphen after the noun', example: '“The plan is long-term.”' },
  { id: 'bold-labels', label: 'Bold as decoration', example: '“- **Performance:** Performance was improved.”' },
  { id: 'decorated-headings', label: 'Decorated headings', example: 'Title Case headings, emoji or arrow bullets.' },
  { id: 'meta-text', label: 'Writing about the document', example: '“The table below compares…”. Docs and posts only.' },
  { id: 'label-template', label: 'Repeated label template', example: '“What it does:”, “Why it’s critical:” opening item after item.' },
  { id: 'hidden-chars', label: 'Hidden and look-alike characters', example: 'Zero-width spaces, or a Cyrillic “а” inside an English word.' },
  { id: 'paste', label: 'Pasted and not edited yet', example: 'Most of the draft arrived in one paste and hasn’t been touched since. Only noticed during this session.' },
];
