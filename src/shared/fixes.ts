import type { Fix } from './types.ts';

/** Apply several local fixes at once. Later fixes go first so earlier offsets stay valid; overlaps are skipped. */
export function applyFixes(text: string, fixes: readonly Fix[]): string {
  let out = text;
  let floor = Infinity;
  for (const f of [...fixes].sort((a, b) => b.start - a.start)) {
    if (f.end > floor) continue;
    out = out.slice(0, f.start) + f.replacement + out.slice(f.end);
    floor = f.start;
  }
  return out;
}
