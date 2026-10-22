import type { RewriteOptions } from '../shared/prompt.ts';
import {
  builtinAvailability, ProviderError, rewriteBuiltin, rewriteOpenAICompatible, startBuiltinSession,
} from '../shared/providers.ts';
import { rewriteRemote, VENDORS } from '../shared/byok/index.ts';
import { loadKey, updateSettings, type Settings } from '../shared/settings.ts';
import { $ } from './render.ts';

export interface EngineStatus {
  readonly label: string;
  readonly ready: boolean;
  readonly note: string;
  readonly privacy: string;
}

const hostOf = (url: string) => new URL(url).host;
const originPattern = (url: string) => `${new URL(url).protocol}//${new URL(url).hostname}/*`;

export async function engineStatus(s: Settings): Promise<EngineStatus> {
  const local = 'Checked on this device. Nothing is sent anywhere.';
  switch (s.provider) {
    case 'none':
      return { label: 'No rewrite engine set up.', ready: false, note: 'The fixes above work without one. Pick an engine in Settings to rewrite the whole draft.', privacy: local };
    case 'builtin': {
      const state = await builtinAvailability();
      const label = 'Chrome built-in AI, on this device';
      const privacy = 'Checked and rewritten on this device. Nothing is sent anywhere.';
      if (state === 'available') return { label, ready: true, note: '', privacy };
      if (state === 'downloadable') return { label, ready: true, note: "The first rewrite downloads Chrome's on-device model. That can take a few minutes.", privacy };
      if (state === 'downloading') return { label, ready: true, note: 'Chrome is downloading its model. Your rewrite will start when it finishes.', privacy };
      return {
        label, ready: false, privacy: local,
        note: state === 'missing'
          ? "This version of Chrome doesn't offer its built-in AI to extensions. The fixes above still work."
          : "This device can't run Chrome's built-in model. The fixes above still work.",
      };
    }
    case 'local': {
      const host = hostOf(s.local.baseUrl);
      const granted = await chrome.permissions.contains({ origins: [originPattern(s.local.baseUrl)] });
      return {
        label: `${s.local.model} at ${host}`,
        ready: granted,
        note: granted ? '' : `SlopMachine needs your permission to reach ${host}. Grant it in Settings.`,
        privacy: `Rewrites go to ${host} on this computer.`,
      };
    }
    case 'byok': {
      const vendor = VENDORS[s.byok.vendor];
      const model = s.byok.models[vendor.id];
      const [key, granted] = await Promise.all([loadKey(vendor.id), chrome.permissions.contains({ origins: [`${vendor.origin}/*`] })]);
      const note = !key ? `Add your ${vendor.label} key in Settings.`
        : !granted ? `Allow SlopMachine to reach ${new URL(vendor.origin).host} in Settings.`
        : !model ? `Pick a ${vendor.label} model in Settings.` : '';
      return {
        label: model ? `${model.label}, ${vendor.label}` : vendor.label,
        ready: !!key && granted && !!model,
        note,
        privacy: `Checked on this device. Rewrites go to ${vendor.label} only after you confirm.`,
      };
    }
  }
}

export function readOptions(purpose: RewriteOptions['purpose']): RewriteOptions {
  const val = (name: string) => (document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? '');
  return {
    tone: val('tone') as RewriteOptions['tone'],
    length: val('length') as RewriteOptions['length'],
    preserveFacts: $<HTMLInputElement>('keepFacts').checked,
    purpose,
  };
}

/** Disclosure before any draft leaves Chrome for a remote provider. Resolves false on Cancel/Esc. */
export function confirmRemote(
  text: string, vendor: (typeof VENDORS)[keyof typeof VENDORS], model: string, o: { purpose?: 'rewrite' | 'review' | 'page' } = {},
): Promise<{ ok: boolean; remember: boolean }> {
  const dialog = $<HTMLDialogElement>('consent');
  const what = o.purpose === 'page' ? 'this page' : 'your draft';
  const why = o.purpose === 'rewrite' || !o.purpose ? 'for a rewrite' : o.purpose === 'page' ? 'for a page check' : 'for an AI review';
  $('consentTitle').textContent = `Send ${what} to ${vendor.label}?`;
  $('consentBody').textContent = `This sends ${what} ${why} directly to ${vendor.label} using your key. SlopMachine never receives it.`;
  $('consentRememberLabel').textContent = `Don't ask again for ${vendor.label}`;
  $<HTMLInputElement>('consentRemember').checked = false;
  $('consentEndpoint').textContent = vendor.origin;
  $('consentModel').textContent = model;
  $('consentSize').textContent = `${text.length.toLocaleString()} characters`;
  $('consentText').textContent = text;
  $('consentSend').textContent = `Send to ${vendor.label}`;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => {
    $('consentText').textContent = '';
    const ok = dialog.returnValue === 'send';
    resolve({ ok, remember: ok && $<HTMLInputElement>('consentRemember').checked });
  }, { once: true }));
}

/** Resolves with the text and who actually wrote it (a provider can route to a fallback model). */
export type RewriteJob = Promise<{ readonly text: string; readonly label: string }>;

/**
 * Called synchronously from the click handler: Chrome's built-in model needs the user
 * activation for its first download, so the session is created before any await.
 */
export function startRewrite(s: Settings, text: string, o: RewriteOptions, signal: AbortSignal, onStatus: (msg: string) => void): RewriteJob {
  if (s.provider === 'builtin') {
    const session = startBuiltinSession(signal, (f) => onStatus(`Downloading Chrome's model, ${Math.round(f * 100)}%`));
    session.catch(() => undefined);
    return rewriteBuiltin(session, text, o, signal).then((t) => ({ text: t, label: "Chrome's built-in AI" }));
  }
  if (s.provider === 'local') {
    return rewriteOpenAICompatible({ label: 'Your local model', baseUrl: s.local.baseUrl, model: s.local.model }, text, o, signal)
      .then((t) => ({ text: t, label: `${s.local.model} at ${hostOf(s.local.baseUrl)}` }));
  }
  if (s.provider === 'byok') {
    const vendor = VENDORS[s.byok.vendor];
    const model = s.byok.models[vendor.id];
    return (async () => {
      if (!model) throw new ProviderError(`Pick a ${vendor.label} model in Settings first.`);
      if (!s.trustedVendors.includes(vendor.id)) {
        const consent = await confirmRemote(text, vendor, model.label);
        if (!consent.ok) throw new ProviderError('Cancelled. Nothing was sent.');
        if (consent.remember) await updateSettings((cur) => ({ ...cur, trustedVendors: [...new Set([...cur.trustedVendors, vendor.id])] }));
      }
      const key = await loadKey(vendor.id);
      if (!key) throw new ProviderError(`Add your ${vendor.label} key in Settings.`);
      onStatus(`Waiting for ${vendor.label}…`);
      const out = await rewriteRemote(vendor.id, key, model, text, o, signal);
      const by = out.servedBy && !out.servedBy.startsWith(model.id) ? `${out.servedBy} (fallback from ${model.label})` : model.label;
      return { text: out.text, label: `${by} via ${vendor.label}` };
    })();
  }
  return Promise.reject(new ProviderError('Pick a rewrite engine in Settings first.'));
}
