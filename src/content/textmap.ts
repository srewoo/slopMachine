/**
 * Plain text of a rich editor plus a map from text offsets back to DOM positions.
 * innerText can't give us offsets, so we walk the tree ourselves.
 */
interface Segment {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

export interface TextMap {
  readonly text: string;
  readonly segments: readonly Segment[];
}

const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR', 'SECTION', 'ARTICLE', 'TABLE']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

const CELL = new Set(['TD', 'TH']);

/**
 * `page` is for whole-page reads (read-only, so synthetic characters are harmless): it skips
 * CSS-hidden subtrees and puts a blank line between blocks, so a heading, a table row and a
 * paragraph never run together into one "paragraph". Editors keep single line breaks.
 */
export function buildTextMap(root: HTMLElement, exclude?: string, page = false): TextMap {
  let text = '';
  const segments: Segment[] = [];
  const breakLine = () => {
    if (!text) return;
    if (!text.endsWith('\n')) text += '\n';
    if (page && !text.endsWith('\n\n')) text += '\n';
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data.replace(/\u00A0/g, ' ');
      if (!data) return;
      segments.push({ node: node as Text, start: text.length, end: text.length + data.length });
      text += data;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (SKIP.has(node.tagName) || node.hidden || (exclude && node.matches(exclude))) return;
    if (page && !node.checkVisibility()) return;
    if (node.tagName === 'BR') {
      // A trailing <br> after content in a block is a placeholder, not a line.
      if (!(node === node.parentNode?.lastChild && node.previousSibling)) text += '\n';
      return;
    }
    const block = BLOCK.has(node.tagName) && node !== root;
    if (block) breakLine();
    node.childNodes.forEach(walk);
    if (block) breakLine();
    else if (CELL.has(node.tagName) && text && !/\s$/.test(text)) text += ' '; // keep table cells apart
  };

  walk(root);
  return { text: text.replace(/\n+$/, ''), segments };
}

/** DOM position for a text offset. `side` picks the neighbour when the offset sits on a synthetic newline. */
function pointAt(map: TextMap, offset: number, side: 'start' | 'end'): [Node, number] | null {
  const segs = map.segments;
  if (!segs.length) return null;
  for (const s of segs) {
    if (side === 'start' ? offset >= s.start && offset < s.end : offset > s.start && offset <= s.end) {
      return [s.node, offset - s.start];
    }
  }
  if (side === 'start') {
    const next = segs.find((s) => s.start >= offset);
    if (next) return [next.node, 0];
    const last = segs[segs.length - 1]!;
    return [last.node, last.node.length];
  }
  const prev = [...segs].reverse().find((s) => s.end <= offset);
  return prev ? [prev.node, prev.node.length] : [segs[0]!.node, 0];
}

export function rangeFor(map: TextMap, start: number, end: number): Range | null {
  const a = pointAt(map, start, 'start');
  const b = start === end ? a : pointAt(map, end, 'end');
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a[0], a[1]);
  range.setEnd(b[0], b[1]);
  if (range.collapsed && start !== end) return null;
  return range;
}
