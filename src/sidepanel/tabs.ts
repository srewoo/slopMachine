import { BroadcastSchema, type Broadcast } from '../shared/messages.ts';

interface Handlers {
  /** The active tab in this panel's window changed (or is known for the first time). */
  readonly tab: (id: number | null) => void;
  /** The tab finished loading. */
  readonly loaded: (id: number) => void;
  /** A validated message from a content script, with its tab and frame ids. */
  readonly broadcast: (msg: Broadcast, tabId: number, frameId: number) => void;
}

/** Follows the active tab of the window this panel lives in, and relays content-script broadcasts. */
export function followActiveTab(on: Handlers): void {
  // Registered synchronously so no early tab switch is missed; filtered once our window id is known.
  let windowId: number | undefined;
  void chrome.windows.getCurrent().then((w) => (windowId = w.id));
  chrome.tabs.onActivated.addListener((info) => (windowId === undefined || info.windowId === windowId) && on.tab(info.tabId));
  chrome.tabs.onUpdated.addListener((id, info) => info.status === 'complete' && on.loaded(id));
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => on.tab(t?.id ?? null));

  chrome.runtime.onMessage.addListener((raw, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    const msg = BroadcastSchema.safeParse(raw);
    if (msg.success) on.broadcast(msg.data, sender.tab.id, sender.frameId ?? 0);
  });
}
