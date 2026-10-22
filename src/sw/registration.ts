import { loadSettings, SITES } from '../shared/settings.ts';

const SCRIPT = 'content.js';

/** Match patterns we should inject into: enabled in settings AND granted by the user. */
async function desiredScripts(): Promise<chrome.scripting.RegisteredContentScript[]> {
  const [settings, granted] = await Promise.all([loadSettings(), chrome.permissions.getAll()]);
  const has = new Set(granted.origins ?? []);
  const out: chrome.scripting.RegisteredContentScript[] = [];
  for (const site of SITES) {
    if (settings.sites[site.id] && site.matches.every((m) => has.has(m))) {
      out.push({ id: site.id, matches: [...site.matches], js: [SCRIPT], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true });
    }
  }
  const generic = settings.genericOrigins.map((o) => `${o}/*`).filter((m) => has.has(m));
  if (generic.length) {
    out.push({ id: 'generic', matches: generic, js: [SCRIPT], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true });
  }
  return out;
}

/**
 * Idempotent: diff what is registered against what should be, then inject into tabs
 * that are already open (registration only affects future page loads).
 */
let queue: Promise<void> = Promise.resolve();

/** Serialized: permission events and the options page can trigger overlapping runs. */
export function reconcile(injectOpenTabs: boolean): Promise<void> {
  const run = queue.then(() => reconcileNow(injectOpenTabs));
  queue = run.catch((e: unknown) => console.error('SlopMachine: content script registration failed', e));
  return run;
}

async function reconcileNow(injectOpenTabs: boolean): Promise<void> {
  const want = await desiredScripts();
  const have = await chrome.scripting.getRegisteredContentScripts();
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((s) => s.id) });
  if (want.length) await chrome.scripting.registerContentScripts(want);
  if (!injectOpenTabs) return;

  const matches = want.flatMap((s) => s.matches ?? []);
  if (!matches.length) return;
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(tabs.map((t) =>
    t.id === undefined ? undefined : chrome.scripting.executeScript({ target: { tabId: t.id }, files: [SCRIPT] }).catch(() => undefined)));
}
