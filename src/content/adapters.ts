export type Editor = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export interface Adapter {
  readonly id: string;
  readonly label: string;
  /** Map a focused element to the editor root we analyze, or null if it is not one. */
  resolve(target: Element): Editor | null;
  /** Rich-editor subtrees that belong to someone else (quoted thread, signature). */
  readonly exclude?: string;
}

export function isFormControl(el: Element): el is HTMLTextAreaElement | HTMLInputElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

/** Never touch password, payment or read-only fields. */
function eligibleControl(el: Element): el is HTMLTextAreaElement | HTMLInputElement {
  if (!isFormControl(el) || el.readOnly || el.disabled) return false;
  if (/^cc-/i.test(el.autocomplete) || /\bcc-/i.test(el.getAttribute('autocomplete') ?? '')) return false;
  return el instanceof HTMLTextAreaElement || el.type === 'text';
}

function editingHost(target: Element): HTMLElement | null {
  if (!(target instanceof HTMLElement) || !target.isContentEditable) return null;
  let host = target;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

function resolveGeneric(target: Element): Editor | null {
  return eligibleControl(target) ? target : editingHost(target);
}

const generic: Adapter = { id: 'generic', label: 'This site', resolve: resolveGeneric };

const gmail: Adapter = {
  id: 'gmail',
  label: 'Gmail',
  resolve: (t) => (t.closest('div[contenteditable="true"][role="textbox"]') as HTMLElement | null) ?? resolveGeneric(t),
  exclude: '.gmail_quote, .gmail_signature, .gmail_signature_prefix, .gmail_extra',
};

const linkedin: Adapter = { id: 'linkedin', label: 'LinkedIn', resolve: resolveGeneric };

export function adapterFor(hostname: string): Adapter {
  if (hostname === 'mail.google.com') return gmail;
  if (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com')) return linkedin;
  return generic;
}
