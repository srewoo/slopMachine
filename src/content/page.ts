import { buildTextMap, rangeFor, type TextMap } from './textmap.ts';

/**
 * Whole-page review, only when the user asks for it from the panel. Reads the main content
 * (the article, not menus, headers, footers, sidebars, forms or hidden text).
 */
const ROOTS = 'article, main, [role="main"], .article-body, #article-body, .post-content, .entry-content';
export const EXCLUDE = [
  'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'textarea', 'input', 'svg', 'iframe',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '[role="search"]', '[aria-hidden="true"]',
].join(', ');

/**
 * The candidate with the most text we would actually read; the body when a site marks up
 * nothing readable. Ranked by readPage, not textContent: a landmark full of scripts or
 * hidden/excluded markup (Confluence) otherwise wins with nothing in it to review.
 */
export function pageRoot(doc: Document = document): HTMLElement {
  let best = doc.body;
  let most = 0;
  for (const el of doc.querySelectorAll<HTMLElement>(ROOTS)) {
    const n = readPage(el).text.trim().length;
    if (n > most) [best, most] = [el, n];
  }
  return best;
}

export function readPage(root: HTMLElement): TextMap {
  return buildTextMap(root, EXCLUDE, true);
}

/** Select and scroll to text on the page. Never edits it. */
export function revealOnPage(root: HTMLElement, start: number, end: number): boolean {
  const range = rangeFor(readPage(root), start, end);
  const sel = root.ownerDocument.getSelection();
  if (!range || !sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}
