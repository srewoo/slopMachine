/**
 * Structural "AI writing" tells, adapted from blader/humanizer (MIT), which is built on
 * Wikipedia's "Signs of AI writing". Word-level tells live in phrases.ts; patterns that need
 * judgment (passive voice hiding the actor, re-explaining what the reader knows, a heading
 * restated in the next line) are left to the AI review.
 *
 * `weak` follows humanizer's "weak alone" rule: such a pattern only counts with company,
 * meaning another hit of the same rule or a strong tell elsewhere in the text.
 */
import type { Purpose } from '../prompt.ts';
import type { Family, Fix, Severity } from '../types.ts';
import { capitalize, isSentenceStart, sentences } from './text.ts';

/** cut: phrase + its trailing punctuation · remove: exactly the match · sentence: the whole sentence */
type FixKind = 'cut' | 'remove' | 'sentence' | ((match: string) => string | null);

export interface TellPattern {
  readonly ruleId: string;
  readonly family: Family;
  readonly severity: Severity;
  readonly base: number;
  readonly re: RegExp;
  readonly title: string;
  readonly message: string;
  readonly fix?: FixKind;
  readonly fixLabel?: string;
  readonly weak?: boolean;
  /** Weak patterns: hits of this rule alone that make it count. */
  readonly minHits?: number;
  readonly only?: readonly Purpose[];
}

const NOT_OUTREACH: readonly Purpose[] = ['marketing', 'content', 'docs'];

export const TELLS: readonly TellPattern[] = [
  // A. Staging instead of stating: act on one sighting.
  {
    ruleId: 'not-x-but-y', family: 'staging', severity: 'warning', base: 8,
    re: /\bnot (?:just|only|merely|simply)\b[^.!?\n]{1,80}?\bbut\b|\b(?:isn'?t|aren'?t|wasn'?t|weren'?t) (?:just|only|merely|simply|about)\b[^.!?\n]{1,80}?[,;—–]\s*(?:it'?s|they'?re|it is|they are|this is|that'?s)\b|\b(?:it'?s|it is|this is|that'?s|that is) not (?:about )?[^.!?\n]{1,60}?[,;—–]\s*(?:it'?s|it is|this is|that'?s)\b|\b(?:this|that|it) (?:does not|doesn'?t) mean\b[^.!?\n]{1,100}[.!?]\s+(?:it|this|that) means\b|,\s+no (?:guessing|fuss|hassle|surprises|strings attached)\b/gi,
    title: 'Say it directly instead of “not X, but Y”',
    message: 'The “not” half argues with something nobody said, to make the second half sound bigger. State the point.',
  },
  {
    ruleId: 'closer', family: 'staging', severity: 'warning', base: 8,
    re: /\b(?:that'?s|that is|this is) the real (?:win|story|point|lesson|difference)\b|\b(?:that|this) distinction matters\b|\bread that again\b|\blet that sink in\b|\bthe message was clear\b|\bthis (?:shows|highlights|underscores|demonstrates) the importance of\b|\bit was a lesson in\b|\bmake no mistake\b|\b(?:[a-z]{3,}\.\s+){2,}[a-z]{3,}\./gi,
    title: 'Cut the dramatic closer',
    message: 'A closing line that restates the point asks the reader to pause instead of telling them something new.',
    fix: 'sentence', fixLabel: 'Cut the line',
  },
  {
    ruleId: 'deep-saying', family: 'staging', severity: 'warning', base: 6,
    re: /\b(?:the real question is|at its core,?|what really matters(?: is)?|the deeper issue(?: is)?|the heart of the matter|in reality,|fundamentally,|(?:is|becomes) the (?:language|currency|architecture) of|becomes a trap)/gi,
    title: 'Replace the saying with the actual claim',
    message: 'An ordinary point dressed up as a hidden truth. Say the specific thing.',
    fix: (m) => (/,$/.test(m) ? '' : null), fixLabel: 'Cut it',
  },
  {
    ruleId: 'run-up', family: 'staging', severity: 'warning', base: 8,
    re: /\b(?:let'?s dive in|let'?s explore|let'?s break (?:this|it) down|here'?s what you need to know|now,? let'?s (?:look at|talk about)|without further ado|heads up|quick note|here'?s the thing|the thing is|let'?s be honest|real talk)\b[:,.!]?|(?<=^|[.!?]\s+)(?:Honestly\?|Look,)/gim,
    title: 'Skip the run-up and make the point',
    message: 'The sentence announces the point, or stages candor, instead of making the point.',
    fix: 'cut', fixLabel: 'Cut it',
  },
  {
    ruleId: 'strawman', family: 'staging', severity: 'warning', base: 6,
    re: /\b(?:this isn'?t (?:mainly |just |really )?about|i'?m not saying|to be clear,|don'?t get me wrong|this is not to say|a tempting approach would be|one might be tempted to|an obvious approach would be|it would be easy to just)\b/gi,
    title: 'Drop the objection nobody raised',
    message: 'The text answers a doubt or rejects an option that appears nowhere else. Keep only the real claim.',
  },

  // B. Rhythm and formatting by rule: mostly weak alone.
  {
    ruleId: 'triads', family: 'structure', severity: 'info', base: 3, weak: true, minHits: 3,
    re: /\b[\w'-]+(?: [\w'-]+)?, [\w'-]+(?: [\w'-]+)?,? and [\w'-]+(?: [\w'-]+)?\b/g,
    title: 'Lists of three everywhere',
    message: 'Ideas keep arriving in threes to sound complete. Keep three only when there really are three.',
  },
  {
    ruleId: 'dashes', family: 'structure', severity: 'info', base: 2, weak: true, minHits: 3,
    re: / ?[—–] ?| -- /g,
    title: 'Dashes doing every job',
    message: 'A dash avoids deciding how two clauses relate. Use a comma, a period or a colon.',
    fix: () => ', ', fixLabel: 'Use a comma',
  },
  {
    ruleId: 'qualifiers', family: 'structure', severity: 'info', base: 3, weak: true,
    re: /\b(?:could potentially|might arguably|may possibly|could possibly|it'?s also possible that|in some cases it may|this is an inference|possibly be argued)\b/gi,
    title: 'Hedges stacked on hedges',
    message: 'Every claim sounds unsure. Keep one qualifier where the doubt is real.',
    fix: (m) => m.replace(/ (?:potentially|arguably|possibly)\b/i, '') || null, fixLabel: 'Drop the extra hedge',
  },
  {
    ruleId: 'hyphen-pair', family: 'structure', severity: 'info', base: 2, weak: true,
    re: /\b(?:is|are|was|were|be|been|feels?|looks?|seems?) (?:high-quality|well-known|well-documented|well-designed|well-maintained|long-term|short-term|real-time|client-facing|user-friendly|up-to-date)\b(?=\s*(?:[,.;:!?)]|$)|\s+(?:and|or|but|so)\b)/gim,
    title: 'Hyphen after the noun',
    message: '“A high-quality report” keeps the hyphen; “the report is high quality” drops it.',
    fix: (m) => m.replace(/-/g, ' '), fixLabel: 'Drop the hyphen',
  },
  {
    ruleId: 'bold-labels', family: 'structure', severity: 'info', base: 3, weak: true, minHits: 2,
    re: /^[ \t]*(?:[-*•]\s*)?\*\*[^*\n]{1,40}:\*\*|\*\*[^*\n]{1,60}\*\*/gm,
    title: 'Bold used as decoration',
    message: 'Bold on every item, or a bold label before every point. Remove it, or turn the labeled list into a sentence.',
  },
  {
    ruleId: 'decorated-headings', family: 'structure', severity: 'info', base: 3,
    re: /^#{1,6}\s+(?=[^\n]*\s(?:And|Of|The|For|To|With|In|On|A)\s)(?:[A-Z][\w'’-]*\s+){2,}[A-Z][\w'’-]*\s*$|^[ \t]*(?:[-*]\s*)?(?:\p{Extended_Pictographic}|→)️?\s/gmu,
    title: 'Decorated heading or list item',
    message: 'Title Case headings, emojis or arrows as bullets. Use sentence case and let the words carry it.',
  },
  {
    ruleId: 'meta-text', family: 'structure', severity: 'info', base: 3, weak: true, only: ['docs', 'content'],
    re: /\b(?:the (?:table|list|section|chart) below (?:compares|shows|lists)|this section is organized|was added to replace|(?:compiled|generated) from|anything (?:we|i) could not confirm)\b/gi,
    title: 'Writing about the document',
    message: 'The text describes itself instead of its subject. Cut it unless the reader can’t see it for themselves.',
  },

  // C. Inflation and borrowed authority.
  {
    ruleId: 'ing-rider', family: 'generic', severity: 'warning', base: 5,
    re: /,\s(?:highlighting|underscoring|emphasizing|emphasising|ensuring|reflecting|symbolizing|symbolising|contributing to|cultivating|fostering|encompassing|showcasing)\b[^.!?\n]*/gi,
    title: 'Cut the “…, highlighting X” tail',
    message: 'An -ing phrase bolted onto a plain fact to make it sound deeper.',
    fix: 'remove', fixLabel: 'Cut the tail',
  },
  {
    ruleId: 'borrowed-authority', family: 'specificity', severity: 'warning', base: 6,
    re: /\b(?:experts (?:argue|believe|say|agree|suggest)|observers have (?:noted|cited)|industry reports (?:suggest|show)|some critics|studies (?:show|suggest|have shown)|research (?:shows|suggests)|according to experts|many believe)\b/gi,
    title: 'Name the source or drop the claim',
    message: 'An unnamed authority stands in for what was actually said.',
  },
  {
    ruleId: 'vague-link', family: 'specificity', severity: 'info', base: 3, weak: true,
    re: /\b(?:is|are|was|were) (?:closely )?(?:associated with|connected to|linked to|tied to)\b|\bin (?:association|connection) with\b/gi,
    title: 'Say how they are connected',
    message: '“Associated with” hides the actual relationship. Name it if you know it.',
  },

  // E. Leftovers from the chat and the draft: remove outright.
  {
    ruleId: 'chat-residue', family: 'leftovers', severity: 'critical', base: 20,
    re: /\b(?:as an ai(?: language model)?|great question|you'?re absolutely right|certainly!|of course!|here is (?:a|an|the|your) (?:revised|updated|improved|rewritten|polished|refined) (?:version|draft|email|text)|i'?d be happy to help)/gi,
    title: 'Remove the chatbot leftover',
    message: 'A chatbot’s greeting, praise or offer is still in the text. It is the most certain tell there is.',
    fix: 'sentence', fixLabel: 'Remove it',
  },
  {
    ruleId: 'chat-residue', family: 'leftovers', severity: 'warning', base: 10, only: NOT_OUTREACH,
    re: /\b(?:i hope this helps|would you like me to|want me to|should i continue|let me know if you'?d like me to|feel free to (?:reach out|ask) if you have any (?:other |further )?questions)\b/gi,
    title: 'Remove the chatbot leftover',
    message: 'A chatbot’s offer or sign-off is still in the text. Keep the content, drop the wrapper.',
    fix: 'sentence', fixLabel: 'Remove it',
  },
  {
    ruleId: 'knowledge-limit', family: 'leftovers', severity: 'critical', base: 20,
    re: /\b(?:as of my (?:last )?(?:knowledge|training) (?:update|cutoff)|up to my last training|while specific details (?:are|is) (?:limited|scarce)|based on (?:the )?available information|(?:is|are) not (?:publicly available|widely documented|widely disclosed)|in the (?:provided|available) sources|maintains a low profile|it is believed that)\b/gi,
    title: 'Remove the knowledge-limit disclaimer',
    message: 'The text talks about what its writer could not find, then guesses. State what is known or cut it.',
    fix: 'sentence', fixLabel: 'Remove it',
  },
];

/** Cut a phrase plus its trailing punctuation; recapitalize what now opens the sentence. */
function cutFix(text: string, start: number, end: number): Fix {
  let stop = end + (text.slice(end).match(/^[:,.!?]*[ \t]*/)?.[0].length ?? 0);
  let replacement = '';
  const next = text.charAt(stop);
  if (isSentenceStart(text, start) && /[a-z]/.test(next)) {
    replacement = next.toUpperCase();
    stop += 1;
  }
  return { label: 'Cut it', replacement, start, end: stop };
}

/** Remove the whole sentence holding the match, and the space after it. */
function sentenceFix(text: string, start: number): Fix | undefined {
  const s = sentences(text).find((x) => start >= x.start && start < x.end);
  if (!s) return undefined;
  const trailing = text.slice(s.end).match(/^[ \t]*/)?.[0].length ?? 0;
  return { label: 'Remove it', replacement: '', start: s.start, end: s.end + trailing };
}

export function tellFix(p: TellPattern, text: string, start: number, end: number): Fix | undefined {
  if (!p.fix) return undefined;
  if (p.fix === 'sentence') return sentenceFix(text, start);
  if (p.fix === 'remove') return { label: p.fixLabel ?? 'Cut it', replacement: '', start, end };
  const cut = cutFix(text, start, end);
  if (p.fix === 'cut') return { ...cut, label: p.fixLabel ?? cut.label };
  const replacement = p.fix(text.slice(start, end));
  if (replacement === null) return undefined;
  if (replacement === '') return { ...cut, label: p.fixLabel ?? cut.label };
  const original = text.slice(start, end);
  return { label: p.fixLabel ?? 'Fix it', replacement: /^[A-Z]/.test(original) ? capitalize(replacement) : replacement, start, end };
}

/** A short row of tiny sentences: “No aesthetic prior. No nostalgia. The old rules were gone.” */
export function fragmentRows(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const list = sentences(text);
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j < list.length && list[j]!.text.split(/\s+/).length <= 3 && /[.!]$/.test(list[j]!.text)) j++;
    const span = { start: list[i]!.start, end: list[Math.max(i, j - 1)]!.end };
    // Same paragraph only, so a sign-off like “Thanks. Talk soon. Sam.” across lines doesn't count.
    if (j - i >= 3 && !text.slice(span.start, span.end).includes('\n')) out.push(span);
    i = Math.max(j, i + 1);
  }
  return out;
}
