/**
 * Style statistics for authorship estimation. Each is a rate or a ratio, so text length matters
 * only through `log_words`. Text should already be normalized (see normalize.ts).
 */
import { analyze } from '../rules/engine.ts';
import { paragraphs, sentences } from '../rules/text.ts';

const FUNCTION_WORDS = new Set(('the a an of to in and or but for on at by with from as is are was were be been being it its this that these those '
  + 'there their they them he she his her we our you your i me my not no so if then than which who whom whose what when where how all any each '
  + 'some such can could would should will may might must do does did have has had').split(' '));
const TRANSITIONS = /\b(?:however|moreover|furthermore|additionally|overall|ultimately|consequently|therefore|thus|notably|importantly|in conclusion|in summary|in addition|as a result|for example|for instance|on the other hand)\b/gi;
// Words chat models overuse relative to people (Liang et al. 2024, Kobak et al. 2024).
const LLM_VOCAB = /\b(?:delve|delves|delving|tapestry|intricate|pivotal|crucial|seamless(?:ly)?|robust|leverag(?:e|es|ing)|landscape|realm|foster(?:s|ing)?|underscore(?:s|d)?|showcas(?:e|es|ing)|comprehensive|meticulous(?:ly)?|navigat(?:e|es|ing)|vibrant|bolster(?:s|ed)?|garner(?:ed)?|streamlin(?:e|es|ed|ing)|elevate[sd]?|empower(?:s|ing)?|unlock(?:s|ing)?|harness(?:es|ing)?|nuanced|multifaceted|paramount|commendable|insightful|invaluable|game-?changer|transformative|holistic|dynamic|ever-evolving|cutting-edge)\b/gi;

export const STYLE_FEATURES = [
  'log_words', 'sent_len_mean', 'sent_len_cv', 'sent_len_range', 'word_len_mean', 'long_word_rate', 'mattr', 'function_rate',
  'comma_per_sent', 'colon_semi_rate', 'dash_rate', 'paren_rate', 'question_rate', 'exclaim_rate', 'quote_rate',
  'first_person_rate', 'second_person_rate', 'contraction_rate', 'digit_rate', 'caps_mid_rate', 'para_len_cv',
  'start_diversity', 'transition_rate', 'llm_vocab_rate', 'lower_start_rate', 'typo_rate', 'list_line_rate',
  'rule_staging', 'rule_generic', 'rule_structure',
] as const;
export type StyleFeature = (typeof STYLE_FEATURES)[number];

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: readonly number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** Moving-average type-token ratio: vocabulary richness that does not fall with length. */
function mattr(tokens: readonly string[], window = 50): number {
  if (tokens.length <= window) return tokens.length ? new Set(tokens).size / tokens.length : 0;
  const counts = new Map<string, number>();
  for (const t of tokens.slice(0, window)) counts.set(t, (counts.get(t) ?? 0) + 1);
  let sum = counts.size;
  for (let i = window; i < tokens.length; i++) {
    const out = tokens[i - window]!;
    const c = counts.get(out)! - 1;
    if (c) counts.set(out, c); else counts.delete(out);
    counts.set(tokens[i]!, (counts.get(tokens[i]!) ?? 0) + 1);
    sum += counts.size;
  }
  return sum / (tokens.length - window + 1) / window;
}

export function styleFeatures(text: string): Record<StyleFeature, number> {
  const words = text.match(/[A-Za-z][A-Za-z'’-]*|\d+(?:[.,]\d+)*/g) ?? [];
  const lower = words.map((w) => w.toLowerCase());
  const n = Math.max(1, words.length);
  const per100 = (k: number) => (100 * k) / n;
  const sents = sentences(text).map((s) => s.text).filter((s) => /[A-Za-z]/.test(s));
  const sentLens = sents.map((s) => s.split(/\s+/).length);
  const ns = Math.max(1, sents.length);
  const paras = paragraphs(text).map((p) => p.text.split(/\s+/).length);
  const firstWords = sents.map((s) => s.split(/\s+/)[0]!.toLowerCase().replace(/[^a-z']/g, ''));
  const lines = text.split('\n').filter((l) => l.trim());
  const rules = analyze(text, { purpose: 'content', mutedRules: [], allowList: [], customPhrases: [] }).byFamily;
  const sm = mean(sentLens);
  return {
    log_words: Math.log(n),
    sent_len_mean: sm,
    sent_len_cv: sm ? std(sentLens) / sm : 0,
    sent_len_range: sentLens.length ? Math.log1p(Math.max(...sentLens) - Math.min(...sentLens)) : 0,
    word_len_mean: mean(words.map((w) => w.length)),
    long_word_rate: per100(words.filter((w) => w.length >= 9).length),
    mattr: mattr(lower),
    function_rate: lower.filter((w) => FUNCTION_WORDS.has(w)).length / n,
    comma_per_sent: count(text, /,/g) / ns,
    colon_semi_rate: per100(count(text, /[;:]/g)),
    dash_rate: per100(count(text, /—|–| - |--/g)),
    paren_rate: per100(count(text, /\(/g)),
    question_rate: count(text, /\?/g) / ns,
    exclaim_rate: count(text, /!/g) / ns,
    quote_rate: per100(count(text, /"/g)),
    first_person_rate: per100(lower.filter((w) => /^(?:i|me|my|mine|i'm|i've|i'd|i'll)$/.test(w)).length),
    second_person_rate: per100(lower.filter((w) => /^(?:you|your|yours|you're|you've|you'll)$/.test(w)).length),
    contraction_rate: per100(count(text, /[A-Za-z]'(?:s|t|re|ve|ll|d|m)\b/g)),
    digit_rate: per100(count(text, /\d+/g)),
    caps_mid_rate: per100(count(text, /(?<=[a-z,;] )[A-Z][a-z]+/g)),
    para_len_cv: paras.length > 1 ? std(paras) / Math.max(1, mean(paras)) : 0,
    start_diversity: firstWords.length ? new Set(firstWords).size / firstWords.length : 1,
    transition_rate: per100(count(text, TRANSITIONS)),
    llm_vocab_rate: per100(count(text, LLM_VOCAB)),
    lower_start_rate: sents.filter((s) => /^[a-z]/.test(s)).length / ns,
    typo_rate: per100(count(text, /\bi\b(?!\.)|\s[,.](?=\S)|([a-z])\1\1|  |\b(?:teh|dont|cant|wont|im|ive|thier|recieve|alot|definately|seperate)\b/g)),
    list_line_rate: lines.length ? lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s/.test(l)).length / lines.length : 0,
    rule_staging: per100((rules.staging ?? 0) + (rules.leftovers ?? 0)),
    rule_generic: per100(rules.generic ?? 0),
    rule_structure: per100(rules.structure ?? 0),
  };
}
