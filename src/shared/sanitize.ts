export const MAX_OUTPUT_CHARS = 16_000;

/** Model output → plain text safe to diff and insert. Rendered with textContent only, never HTML. */
export function sanitizeOutput(raw: string): string {
  let text = raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
  text = text.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, '$1').trim();
  text = text.replace(/^<draft>\s*([\s\S]*?)\s*<\/draft>$/i, '$1').trim();
  if (/^["“].*["”]$/s.test(text) && !/["“”]/.test(text.slice(1, -1))) text = text.slice(1, -1).trim();
  return text.slice(0, MAX_OUTPUT_CHARS);
}

/** Strip anything that looks like a secret before an error reaches the UI. */
export function scrubError(message: string): string {
  return message.replace(/(sk|key|Bearer)[-_ ]?[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 300);
}
