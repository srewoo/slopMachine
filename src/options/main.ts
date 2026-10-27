import { VENDOR_IDS } from '../shared/byok/types.ts';
import { RULES } from '../shared/rules/detectors.ts';
import {
  coerceSettings, DEFAULT_SETTINGS, loadSettings, storeKey, onSettingsChanged, parseSettings, saveSettings, SITES, updateSettings, type Settings,
} from '../shared/settings.ts';
import { $, h } from '../sidepanel/render.ts';
import { parseSitePattern } from '../shared/sites.ts';
import { initProviders } from './providers.ts';

let settings: Settings = DEFAULT_SETTINGS;
let toastTimer: number | undefined;

export function toast(msg: string): void {
  $('status').textContent = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ($('status').textContent = ''), 4000);
}

const syncSites = () => chrome.runtime.sendMessage({ v: 1, type: 'sites/sync' }).catch(() => undefined);
const lines = (s: string) => [...new Set(s.split('\n').map((l) => l.trim()).filter(Boolean))];

function switchRow(title: string, detail: string, checked: boolean, onChange: (on: boolean, input: HTMLInputElement) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('div', { class: 'row' },
    h('div', {}, h('strong', {}, title), h('p', { class: 'muted' }, detail)),
    h('label', { class: 'switch' }, input, h('span', { class: 'visually-hidden' }, title)));
}

function renderSites(): void {
  $('siteRows').replaceChildren(...SITES.map((site) => switchRow(site.label, site.reason, settings.sites[site.id], async (on, input) => {
    if (on) {
      // permissions.request must be the first await: it needs this click's user activation.
      const granted = await chrome.permissions.request({ origins: [...site.matches] });
      if (!granted) {
        input.checked = false;
        return toast(`Chrome didn't grant access to ${site.label}. Nothing changed.`);
      }
    }
    settings = await updateSettings((s) => ({ ...s, sites: { ...s.sites, [site.id]: on } }));
    if (!on) await chrome.permissions.remove({ origins: [...site.matches] }).catch(() => false);
    await syncSites();
    toast(on ? `${site.label} is on. Open or reload a ${site.label} tab and start writing.` : `${site.label} is off and its access was removed.`);
  })));

  $('genericList').replaceChildren(...settings.genericOrigins.map((origin) => {
    const remove = h('button', { class: 'btn-quiet', type: 'button', 'aria-label': `Remove ${origin}` }, 'Remove');
    remove.addEventListener('click', async () => {
      settings = await updateSettings((s) => ({ ...s, genericOrigins: s.genericOrigins.filter((o) => o !== origin) }));
      await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
      await syncSites();
      toast(`${origin} removed.`);
    });
    return h('li', {}, origin, remove);
  }));
  $<HTMLInputElement>('minWords').value = String(settings.minWords);
}

function renderRules(): void {
  $('ruleRows').replaceChildren(...RULES.map((rule) => switchRow(rule.label, rule.example, !settings.mutedRules.includes(rule.id), async (on) => {
    settings = await updateSettings((s) => ({
      ...s, mutedRules: on ? s.mutedRules.filter((r) => r !== rule.id) : [...new Set([...s.mutedRules, rule.id])],
    }));
  })));
  $<HTMLTextAreaElement>('allowList').value = settings.allowList.join('\n');
  $<HTMLTextAreaElement>('customPhrases').value = settings.customPhrases.join('\n');
}

function render(): void {
  renderSites();
  renderRules();
}

function wireSites(): void {
  $('genericForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('genericOrigin');
    const origin = parseSitePattern(input.value);
    if (!origin) return toast('Enter an https site such as example.com, help.example.com or *.example.com.');
    if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) return toast(`Chrome didn't grant access to ${origin}.`);
    try {
      settings = await updateSettings((s) => ({ ...s, genericOrigins: [...new Set([...s.genericOrigins, origin])] }));
    } catch {
      await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => false);
      return toast(`Couldn't save ${origin}. Nothing changed.`);
    }
    await syncSites();
    input.value = '';
    toast(`${origin} added. Reload its tab to start.`);
  });

  $('minWords').addEventListener('change', async () => {
    const n = Number($<HTMLInputElement>('minWords').value);
    if (!Number.isInteger(n) || n < 5 || n > 200) return toast('Pick a whole number between 5 and 200.');
    settings = await updateSettings((s) => ({ ...s, minWords: n }));
    toast('Saved.');
  });
}

function wireRules(): void {
  $('allowList').addEventListener('change', async () => {
    settings = await updateSettings((s) => ({ ...s, allowList: lines($<HTMLTextAreaElement>('allowList').value) }));
    toast('Saved.');
  });
  $('customPhrases').addEventListener('change', async () => {
    settings = await updateSettings((s) => ({ ...s, customPhrases: lines($<HTMLTextAreaElement>('customPhrases').value) }));
    toast('Saved.');
  });
  $('resetRules').addEventListener('click', async () => {
    settings = await updateSettings((s) => ({ ...s, mutedRules: [], allowList: [], customPhrases: [] }));
    toast('Rules reset.');
  });
}

function wireData(): void {
  $('exportBtn').addEventListener('click', () => {
    // Settings never hold keys or draft text; keys live under separate storage entries.
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'slopmachine-settings.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('importFile').addEventListener('change', async () => {
    const input = $<HTMLInputElement>('importFile');
    const file = input.files?.[0];
    input.value = '';
    if (!file || file.size > 200_000) return toast('That file is too large to be a settings export.');
    let parsed: Settings | null = null;
    try {
      const json: unknown = JSON.parse(await file.text());
      // An export from an older build keeps whatever is still valid.
      parsed = parseSettings(json) ?? ((json as { version?: unknown })?.version === 1 ? coerceSettings(json) : null);
    } catch { /* reported below */ }
    if (!parsed) return toast("That file isn't a SlopMachine settings export. Nothing changed.");
    // Imported sites still need Chrome's permission; they stay off until granted here.
    const granted = (await chrome.permissions.getAll()).origins ?? [];
    const sites = Object.fromEntries(SITES.map((s) => [s.id, parsed.sites[s.id] && s.matches.every((m) => granted.includes(m))])) as Settings['sites'];
    await saveSettings({ ...parsed, sites, genericOrigins: parsed.genericOrigins.filter((o) => granted.includes(`${o}/*`)) });
    await syncSites();
    toast('Settings imported. Turn on any sites again to grant access.');
  });

  $('clearSession').addEventListener('click', async () => {
    await chrome.storage.session.clear();
    toast('Session data cleared.');
  });

  let armed = false;
  $('deleteAll').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('deleteAll');
    if (!armed) {
      armed = true;
      btn.textContent = 'Click again to delete';
      window.setTimeout(() => { armed = false; btn.textContent = 'Delete'; }, 5000);
      return;
    }
    const origins = (await chrome.permissions.getAll()).origins ?? [];
    await Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear(), ...VENDOR_IDS.map((v) => storeKey(v, '', false))]);
    if (origins.length) await chrome.permissions.remove({ origins }).catch(() => false);
    await syncSites();
    armed = false;
    btn.textContent = 'Delete';
    toast('Everything was deleted.');
  });
}

async function main(): Promise<void> {
  settings = await loadSettings();
  render();
  wireSites();
  // From the side panel's "Add <site>": prefilled only. Adding still takes the user's click and Chrome's prompt.
  const suggested = parseSitePattern(new URLSearchParams(location.search).get('site') ?? '');
  if (suggested) $<HTMLInputElement>('genericOrigin').value = suggested.slice('https://'.length);
  wireRules();
  wireData();
  const renderProviders = initProviders(() => settings, (s) => { settings = s; });
  onSettingsChanged((s) => {
    settings = s;
    render();
    void renderProviders();
  });
}

void main();
