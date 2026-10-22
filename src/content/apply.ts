import { isFormControl, type Editor } from './adapters.ts';
import { buildTextMap, rangeFor } from './textmap.ts';

export function extractText(el: Editor, exclude?: string): string {
  return isFormControl(el) ? el.value : buildTextMap(el, exclude).text;
}

const loose = (s: string) => s.replace(/\s+/g, ' ').trim();

export function select(el: Editor, start: number, end: number, exclude?: string): boolean {
  el.focus({ preventScroll: true });
  if (isFormControl(el)) {
    el.setSelectionRange(start, end);
    return true;
  }
  const range = rangeFor(buildTextMap(el, exclude), start, end);
  const sel = el.ownerDocument.getSelection();
  if (!range || !sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/**
 * Replace text[start,end) through the browser's editing pipeline so the host's own
 * Cmd/Ctrl+Z undoes it. execCommand('insertText') is the only path that reliably lands
 * on the native undo stack in Gmail/LinkedIn; the result is verified and rolled back if wrong.
 */
export function replaceRange(el: Editor, start: number, end: number, replacement: string, exclude?: string): 'ok' | 'verify-failed' {
  const before = extractText(el, exclude);
  const expected = before.slice(0, start) + replacement + before.slice(end);
  if (!select(el, start, end, exclude)) return 'verify-failed';

  const doc = el.ownerDocument;
  const inserted = replacement
    ? doc.execCommand('insertText', false, replacement)
    : doc.execCommand('delete', false);

  const fallback = !inserted && isFormControl(el);
  if (fallback) {
    el.setRangeText(replacement, start, end, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: replacement }));
  }

  if (loose(extractText(el, exclude)) === loose(expected)) return 'ok';
  if (inserted) doc.execCommand('undo', false);
  else if (fallback) {
    el.value = before;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'historyUndo' }));
  }
  return 'verify-failed';
}
