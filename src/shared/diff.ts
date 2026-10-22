export interface DiffOp {
  readonly type: 'eq' | 'del' | 'ins';
  readonly text: string;
}

const tokenize = (s: string): string[] => s.match(/^\s+|\S+\s*/g) ?? [];

// ponytail: O(n·m) LCS table; above MAX_CELLS we show a whole-block replace. Swap for Myers if drafts grow.
const MAX_CELLS = 6_000_000;

/** Word-level diff. Words compare without their trailing whitespace. */
export function diffWords(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const key = (t: string) => t.trim();

  let pre = 0;
  while (pre < a.length && pre < b.length && key(a[pre]!) === key(b[pre]!)) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && key(a[a.length - 1 - suf]!) === key(b[b.length - 1 - suf]!)) suf++;

  const ops: DiffOp[] = [];
  const push = (type: DiffOp['type'], text: string) => {
    const last = ops[ops.length - 1];
    if (last?.type === type) ops[ops.length - 1] = { type, text: last.text + text };
    else if (text) ops.push({ type, text });
  };

  b.slice(0, pre).forEach((t) => push('eq', t));
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  const n = ma.length;
  const m = mb.length;

  if (n * m > MAX_CELLS) {
    push('del', ma.join(''));
    push('ins', mb.join(''));
  } else {
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = key(ma[i]!) === key(mb[j]!) ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (key(ma[i]!) === key(mb[j]!)) { push('eq', mb[j]!); i++; j++; }
      else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) push('del', ma[i++]!);
      else push('ins', mb[j++]!);
    }
    while (i < n) push('del', ma[i++]!);
    while (j < m) push('ins', mb[j++]!);
  }

  b.slice(b.length - suf).forEach((t) => push('eq', t));
  return ops;
}

/** Smallest single range in `before` that turns it into `after`. */
export function changedRange(before: string, after: string): { start: number; end: number; replacement: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start, end: before.length - tail, replacement: after.slice(start, after.length - tail) };
}

export function diffStats(ops: readonly DiffOp[]): { removed: number; added: number } {
  const words = (t: string) => t.match(/\S+/g)?.length ?? 0;
  return ops.reduce(
    (acc, op) => (op.type === 'del' ? { ...acc, removed: acc.removed + words(op.text) } : op.type === 'ins' ? { ...acc, added: acc.added + words(op.text) } : acc),
    { removed: 0, added: 0 },
  );
}
