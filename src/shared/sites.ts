/**
 * "Other sites" entries, stored as `https://host` or `https://*.domain`, which is also the
 * Chrome match-pattern host form. `*.domain` covers the domain itself and every subdomain.
 */
export const SITE_PATTERN = /^https:\/\/(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+$/;

/**
 * Accepts what people paste: `mindtickle.com`, `help.mindtickle.com`, `*.mindtickle.com`,
 * `https://*.mindtickle.com/`, a full URL with a path or port. Returns null for anything else,
 * including plain http, a bare `*`, or a wildcard over a whole TLD (`*.com`).
 */
export function parseSitePattern(input: string): string | null {
  let rest = input.trim().toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(rest);
  if (scheme && scheme[1] !== 'https') return null;
  rest = rest.slice(scheme ? scheme[0].length : 0).split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/\.$/, '');

  const wildcard = rest.startsWith('*.');
  const host = wildcard ? rest.slice(2) : rest;
  if (!host || host.includes('*')) return null;
  let ascii: string;
  try {
    ascii = new URL(`https://${host}`).hostname; // punycode for international domains
  } catch {
    return null;
  }
  if (wildcard && ascii.split('.').length < 2) return null;
  const pattern = `https://${wildcard ? '*.' : ''}${ascii}`;
  return SITE_PATTERN.test(pattern) ? pattern : null;
}

/** Same rule Chrome applies to the registered match pattern. */
export function siteMatches(pattern: string, hostname: string): boolean {
  const host = pattern.slice('https://'.length);
  if (!host.startsWith('*.')) return hostname === host;
  const domain = host.slice(2);
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
