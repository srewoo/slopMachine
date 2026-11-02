/**
 * Undo the cheap evasion tricks before scoring: invisible characters wedged between letters and
 * look-alike letters from other scripts (RAID's "zero_width_space" and "homoglyph" attacks).
 * Detection scores the cleaned copy; offsets into the original are never needed for it.
 */

/** Zero-width and other invisible format characters. Soft hyphen included. */
export const INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

// Cyrillic, Greek and fullwidth letters that render like Latin ones.
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'һ': 'h',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'ο': 'o', 'ν': 'v', 'α': 'a', 'ι': 'i', 'κ': 'k', 'ρ': 'p', 'τ': 't', 'υ': 'u',
  'ɑ': 'a', 'ɡ': 'g', 'ı': 'i', 'ℓ': 'l',
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

/** A look-alike letter sitting next to a Latin letter: “pаy” with a Cyrillic а. Real Russian or Greek words don't match. */
export const MIXED_SCRIPT_RE = new RegExp(`(?<=[A-Za-z])[${Object.keys(HOMOGLYPHS).join('')}]|[${Object.keys(HOMOGLYPHS).join('')}](?=[A-Za-z])`, 'g');

/** Strips invisible characters and maps look-alike letters to Latin, keeping everything else as is. */
export function unmask(text: string): string {
  return text.replace(INVISIBLE_RE, '').replace(MIXED_SCRIPT_RE, (c) => HOMOGLYPHS[c] ?? c);
}

export interface Normalized {
  readonly text: string;
  readonly invisible: number;
  readonly homoglyphs: number;
}

export function normalizeForDetection(raw: string): Normalized {
  const invisible = raw.match(INVISIBLE_RE)?.length ?? 0;
  const homoglyphs = raw.match(MIXED_SCRIPT_RE)?.length ?? 0;
  const text = raw
    .normalize('NFKC') // fullwidth letters, ligatures, compatibility forms
    .replace(INVISIBLE_RE, '')
    .replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c] ?? c)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, invisible, homoglyphs };
}
