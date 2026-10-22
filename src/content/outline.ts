import { EXCLUDE } from './page.ts';

/**
 * The reviewed article as a light Markdown outline for the AI page check: heading levels,
 * lists, table rows, link text, image alt text and code survive, so the model can judge
 * structure and completeness. Built only when the user asks for a page review.
 */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BLOCKQUOTE', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY']);

export function buildOutline(root: HTMLElement, title: string, max: number): { text: string; truncated: boolean } {
  const lines: string[] = [];
  let inline = '';
  const flush = () => {
    if (squash(inline)) lines.push(squash(inline));
    inline = '';
  };

  const walk = (node: Node, depth: number): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      inline += (node as Text).data;
      return;
    }
    if (!(node instanceof HTMLElement) || node.hidden || node.matches(EXCLUDE) || !node.checkVisibility()) return;
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {
      flush();
      lines.push('', `${'#'.repeat(Number(tag[1]))} ${squash(node.innerText)}`);
    } else if (tag === 'LI') {
      flush();
      const nested = [...node.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
      const own = [...node.childNodes].filter((c) => !nested.includes(c as Element));
      own.forEach((c) => walk(c, depth));
      lines.push(`${'  '.repeat(depth)}- ${squash(inline)}`);
      inline = '';
      nested.forEach((c) => walk(c, depth + 1));
    } else if (tag === 'TR') {
      flush();
      lines.push(`| ${[...node.children].map((c) => squash((c as HTMLElement).innerText)).join(' | ')} |`);
    } else if (tag === 'PRE') {
      flush();
      lines.push('```', node.innerText.replace(/\n+$/, ''), '```');
    } else if (tag === 'IMG') {
      const alt = squash((node as HTMLImageElement).alt);
      if (alt) inline += ` [Image: ${alt}] `;
    } else if (tag === 'BR') {
      flush();
    } else {
      const block = BLOCK.has(tag);
      if (block) flush();
      node.childNodes.forEach((c) => walk(c, depth));
      if (block) flush();
    }
  };

  walk(root, 0);
  flush();
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const text = `Page title: ${squash(title)}\n\n${body}`;
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}
