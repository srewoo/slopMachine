import { listModels, tuningNote, VENDORS, type RemoteModel, type Vendor } from '../shared/byok/index.ts';
import { ProviderError } from '../shared/providers.ts';
import { loadKey, storeKey, type Settings } from '../shared/settings.ts';
import { $, h } from '../sidepanel/render.ts';

type Save = (patch: (s: Settings) => Settings) => Promise<void>;

function report(msg: string, tone: 'ok' | 'error'): void {
  $('byokResult').textContent = msg;
  $('byokResult').dataset['tone'] = tone;
}

/** BYOK settings: provider, key, and a model list fetched with that key. Returns the render function. */
export function initByok(get: () => Settings, save: Save): () => Promise<void> {
  // The fetched list lives in memory only; the chosen model is what gets saved.
  let loaded: { vendor: Vendor; models: RemoteModel[] } | null = null;
  const vendorOf = () => VENDORS[get().byok.vendor];

  const render = async () => {
    const s = get();
    const v = vendorOf();
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name="vendor"]')) r.checked = r.value === v.id;
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name="keyStore"]')) r.checked = r.value === (s.byok.rememberKey ? 'local' : 'session');
    $('keyLabel').textContent = `${v.label} API key`;
    $<HTMLInputElement>('byokKey').placeholder = v.keyPlaceholder;
    $('keyState').textContent = (await loadKey(v.id))
      ? `A ${v.label} key is saved ${s.byok.rememberKey ? 'on this device' : 'until Chrome closes'}.`
      : `No ${v.label} key saved.`;
    $<HTMLInputElement>('askEachSend').checked = !s.trustedVendors.includes(v.id);
    $('askEachSendLabel').textContent = `Ask before each send to ${v.label}`;
    $('byokProbe').textContent = `Loading models asks ${v.origin} which models this key can use. It never sends a draft.`;

    const chosen = s.byok.models[v.id];
    const options = loaded?.vendor === v.id ? loaded.models : chosen ? [chosen] : [];
    const select = $<HTMLSelectElement>('byokModel');
    select.disabled = options.length === 0;
    select.replaceChildren(...(options.length
      ? options.map((m) => h('option', { value: m.id }, m.reasoning ? `${m.label} · thinking` : m.label))
      : [h('option', { value: '' }, 'Load models to choose one')]));
    select.value = chosen?.id ?? '';
    $('modelNote').textContent = chosen ? tuningNote(v.id, chosen) : '';
  };

  $('vendorChoices').addEventListener('change', async (e) => {
    const vendor = (e.target as HTMLInputElement).value as Vendor;
    // Clear before awaiting, so a key typed right after switching can't be wiped or filed under the old provider.
    $<HTMLInputElement>('byokKey').value = '';
    report('', 'ok');
    await save((s) => ({ ...s, byok: { ...s.byok, vendor } }));
    await render();
  });

  document.querySelectorAll<HTMLInputElement>('input[name="keyStore"]').forEach((r) => r.addEventListener('change', async () => {
    const remember = r.value === 'local' && r.checked;
    await save((s) => ({ ...s, byok: { ...s.byok, rememberKey: remember } }));
    for (const id of Object.keys(VENDORS) as Vendor[]) {
      const key = await loadKey(id);
      if (key) await storeKey(id, key, remember);
    }
    await render();
  }));

  $('byokLoad').addEventListener('click', async () => {
    const v = vendorOf();
    // permissions.request must be the first await: it needs this click's activation.
    if (!(await chrome.permissions.request({ origins: [`${v.origin}/*`] }))) {
      return report(`Chrome did not grant access to ${new URL(v.origin).host}, so nothing was sent.`, 'error');
    }
    const input = $<HTMLInputElement>('byokKey');
    const typed = input.value.trim();
    if (typed) await storeKey(v.id, typed, get().byok.rememberKey);
    input.value = ''; // never leave the key visible after saving
    const key = typed || (await loadKey(v.id));
    if (!key) return report('Paste a key first.', 'error');

    report('Loading models…', 'ok');
    try {
      const models = await listModels(v.id, key, new AbortController().signal);
      if (!models.length) return report(`This ${v.label} key has no text models available.`, 'error');
      loaded = { vendor: v.id, models };
      const current = get().byok.models[v.id];
      // Keep the saved choice if the key still offers it (refreshing its details); otherwise take the newest.
      const pick = models.find((m) => m.id === current?.id) ?? models[0]!;
      await save((s) => ({ ...s, byok: { ...s.byok, models: { ...s.byok.models, [v.id]: pick } } }));
      report(`Key works. ${models.length} model${models.length === 1 ? '' : 's'} available.`, 'ok');
    } catch (e) {
      report(e instanceof ProviderError ? e.message : 'Loading models failed.', 'error');
    }
    await render();
  });

  $('askEachSend').addEventListener('change', async () => {
    const v = vendorOf().id;
    const ask = $<HTMLInputElement>('askEachSend').checked;
    await save((s) => ({ ...s, trustedVendors: ask ? s.trustedVendors.filter((x) => x !== v) : [...new Set([...s.trustedVendors, v])] }));
  });

  $('byokModel').addEventListener('change', async () => {
    const v = vendorOf();
    const model = loaded?.vendor === v.id ? loaded.models.find((m) => m.id === $<HTMLSelectElement>('byokModel').value) : undefined;
    if (!model) return;
    await save((s) => ({ ...s, byok: { ...s.byok, models: { ...s.byok.models, [v.id]: model } } }));
    await render();
  });

  $('byokForget').addEventListener('click', async () => {
    const v = vendorOf();
    await storeKey(v.id, '', false);
    await chrome.permissions.remove({ origins: [`${v.origin}/*`] }).catch(() => false);
    loaded = null;
    await render();
    report(`${v.label} key and access removed.`, 'ok');
  });

  return render;
}
