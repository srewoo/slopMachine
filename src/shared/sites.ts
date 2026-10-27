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

/**
 * What to suggest adding for an editor's frame. Hosts whose first label is generated per
 * document (`<uuid>.frame.claudeusercontent.com`) get the parent wildcard, or the user would
 * have to add every new document by hand. Any other host is suggested as is.
 */
export function suggestSitePattern(hostname: string): string | null {
  const [first, ...rest] = hostname.split('.');
  const generated = !!first && first.length >= 20 && /\d/.test(first) && rest.length >= 2;
  return parseSitePattern(generated ? `*.${rest.join('.')}` : hostname);
}
