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

/** The candidate holding the most text; the body when a site marks up nothing. */
export function pageRoot(doc: Document = document): HTMLElement {
  const candidates = [...doc.querySelectorAll<HTMLElement>(ROOTS)];
  return candidates.sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0] ?? doc.body;
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
