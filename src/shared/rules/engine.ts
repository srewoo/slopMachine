import { FAMILY_CAPS, statusFor, type Analysis, type EditSignals, type Family, type Issue, type RuleSettings } from '../types.ts';
import { DETECTORS } from './detectors.ts';
import { countWords } from './text.ts';

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

export const NO_SIGNALS: EditSignals = { largestPasteChars: 0, editedCharsSincePaste: 0 };

/**
 * Pure and deterministic: same text + settings + signals → same result.
 * Points are awarded per family until its cap; issues past the cap stay visible with 0 points,
 * so the score is always exactly the sum of issue points.
 */
export function analyze(
  text: string,
  settings: RuleSettings,
  signals: EditSignals = NO_SIGNALS,
  ignoreKeys: ReadonlySet<string> = new Set(),
): Analysis {
  const muted = new Set(settings.mutedRules);
  const all = DETECTORS.flatMap((d) => d(text, settings, signals)).filter((c) => !muted.has(c.ruleId));
  // humanizer's "weak alone": a weak pattern counts only with company (enough hits of itself,
  // or a strong AI-writing tell elsewhere in the text).
  const strongTells = all.some((c) => !c.weak && (c.family === 'staging' || c.family === 'leftovers'));
  const hits = new Map<string, number>();
  for (const c of all) hits.set(c.ruleId, (hits.get(c.ruleId) ?? 0) + 1);
  const candidates = all
    .filter((c) => !c.weak || strongTells || (hits.get(c.ruleId) ?? 0) >= (c.minHits ?? 2))
    .map((c) => ({ ...c, key: `${c.ruleId}:${c.match.toLowerCase()}` }))
    .filter((c) => !ignoreKeys.has(c.key))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.start - b.start || a.ruleId.localeCompare(b.ruleId));

  const byFamily: Record<Family, number> = { placeholder: 0, leftovers: 0, staging: 0, generic: 0, specificity: 0, structure: 0, paste: 0 };
  const issues: Issue[] = candidates.map(({ base, match: _match, weak: _weak, minHits: _minHits, ...c }) => {
    const points = Math.min(base, FAMILY_CAPS[c.family] - byFamily[c.family]);
    byFamily[c.family] += points;
    return { ...c, id: `${c.ruleId}:${c.start}`, points };
  });

  const score = Math.min(100, Object.values(byFamily).reduce((a, b) => a + b, 0));
  return { score, status: statusFor(score), wordCount: countWords(text), issues, byFamily };
}
