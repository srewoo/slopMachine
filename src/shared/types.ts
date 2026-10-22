import type { Purpose } from './prompt.ts';

export type Family = 'placeholder' | 'leftovers' | 'staging' | 'generic' | 'specificity' | 'structure' | 'paste';
export type Severity = 'critical' | 'warning' | 'info';
export type Status = 'low' | 'review' | 'high';

export interface Fix {
  readonly label: string;
  /** Replaces text[start, end). Empty string removes it. */
  readonly replacement: string;
  /** Range the fix replaces; defaults to the issue range. */
  readonly start: number;
  readonly end: number;
}

export interface Issue {
  readonly id: string;
  readonly ruleId: string;
  /** Stable across offset shifts; used for dismiss. */
  readonly key: string;
  readonly family: Family;
  readonly severity: Severity;
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly message: string;
  readonly points: number;
  readonly fix?: Fix;
  /** Set on findings from the AI review; they are listed but never add to the score. */
  readonly source?: 'ai';
}

export interface Analysis {
  readonly score: number;
  readonly status: Status;
  readonly wordCount: number;
  readonly issues: readonly Issue[];
  /** Points per family, sums to score. */
  readonly byFamily: Readonly<Record<Family, number>>;
}

export interface EditSignals {
  readonly largestPasteChars: number;
  readonly editedCharsSincePaste: number;
}

export interface RuleSettings {
  /** What the text is; defaults to outreach. Some rules only make sense for some kinds of writing. */
  readonly purpose?: Purpose;
  readonly mutedRules: readonly string[];
  readonly allowList: readonly string[];
  readonly customPhrases: readonly string[];
}

/**
 * Points per family stop at its cap; the total is clamped to 100. Caps sum past 100 since the
 * humanizer families joined, so a draft needs problems in several families to reach the top.
 */
export const FAMILY_CAPS: Readonly<Record<Family, number>> = {
  placeholder: 35,
  leftovers: 25,
  staging: 25,
  generic: 25,
  specificity: 20,
  structure: 10,
  paste: 10,
};

export const FAMILY_LABELS: Readonly<Record<Family, string>> = {
  placeholder: 'Template gaps',
  leftovers: 'Chat leftovers',
  staging: 'Staged phrasing',
  generic: 'Stock phrases',
  specificity: 'Vague claims',
  structure: 'Rhythm',
  paste: 'Pasted, not edited',
};

export const MAX_CHARS = 12_000;

export function statusFor(score: number): Status {
  if (score <= 30) return 'low';
  if (score <= 70) return 'review';
  return 'high';
}

export const STATUS_LABELS: Readonly<Record<Status, string>> = {
  low: 'Low review need',
  review: 'Review suggested',
  high: 'High review need',
};
