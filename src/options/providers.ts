import { builtinAvailability, ProviderError, testEndpoint } from '../shared/providers.ts';
import { updateSettings, type ProviderId, type Settings } from '../shared/settings.ts';
import { initByok } from './byok.ts';
import { $ } from '../sidepanel/render.ts';

const BUILTIN_TEXT = {
  available: 'Ready.',
  downloadable: 'Chrome downloads the model the first time you rewrite.',
  downloading: 'Chrome is downloading the model now.',
  unavailable: "This device can't run it.",
  missing: "This Chrome version doesn't offer it to extensions.",
} as const;

function report(id: string, msg: string, tone: 'ok' | 'error'): void {
  $(id).textContent = msg;
  $(id).dataset['tone'] = tone;
}

const loopbackPattern = (url: string): string => `http://${new URL(url).hostname}/*`;

/** Returns its render function so changes made elsewhere (e.g. trust given in the panel) show up here. */
export function initProviders(get: () => Settings, set: (s: Settings) => void): () => Promise<void> {
  const save = async (patch: (s: Settings) => Settings) => set(await updateSettings(patch));

  const renderByok = initByok(get, save);
  $('aiAuto').addEventListener('change', () => save((s) => ({ ...s, aiAuto: $<HTMLInputElement>('aiAuto').checked })));

  const render = async () => {
    const s = get();
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name="provider"]')) r.checked = r.value === s.provider;
    $('localPanel').hidden = s.provider !== 'local';
    $('byokPanel').hidden = s.provider !== 'byok';
    $<HTMLInputElement>('aiAuto').checked = s.aiAuto;
    $<HTMLInputElement>('localUrl').value = s.local.baseUrl;
    $<HTMLInputElement>('localModel').value = s.local.model;
    $('localProbe').textContent = `The test asks ${s.local.baseUrl.replace(/\/$/, '')}/models for its model list. It never sends a draft.`;
    await renderByok();
    const builtin = await builtinAvailability();
    $('builtinState').textContent = BUILTIN_TEXT[builtin];
    const radio = document.querySelector<HTMLInputElement>('input[name="provider"][value="builtin"]');
    if (radio) radio.disabled = (builtin === 'unavailable' || builtin === 'missing') && s.provider !== 'builtin';
  };

  $('extId').textContent = chrome.runtime.id;

  $('providerChoices').addEventListener('change', async (e) => {
    const value = (e.target as HTMLInputElement).value as ProviderId;
    await save((s) => ({ ...s, provider: value }));
    await render();
  });

  $('localUrl').addEventListener('change', async () => {
    const url = $<HTMLInputElement>('localUrl').value.trim();
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(url)) {
      return report('localResult', 'Use an address on localhost or 127.0.0.1, for example http://localhost:11434/v1', 'error');
    }
    await save((s) => ({ ...s, local: { ...s.local, baseUrl: url } }));
    await render();
  });
  $('localModel').addEventListener('change', () => save((s) => ({ ...s, local: { ...s.local, model: $<HTMLInputElement>('localModel').value.trim() } })));

  $('localTest').addEventListener('click', async () => {
    const s = get();
    if (!(await chrome.permissions.request({ origins: [loopbackPattern(s.local.baseUrl)] }))) {
      return report('localResult', 'Chrome did not grant access, so nothing was sent.', 'error');
    }
    report('localResult', 'Testing…', 'ok');
    try {
      report('localResult', await testEndpoint({ label: 'Your local model', baseUrl: s.local.baseUrl, model: s.local.model }), 'ok');
    } catch (e) {
      report('localResult', e instanceof ProviderError ? e.message : 'The test failed.', 'error');
    }
  });

  $('localRevoke').addEventListener('click', async () => {
    await chrome.permissions.remove({ origins: [loopbackPattern(get().local.baseUrl)] }).catch(() => false);
    report('localResult', 'Access removed.', 'ok');
  });

  void render();
  return render;
}
