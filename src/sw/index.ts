import { BroadcastSchema, SyncSitesSchema } from '../shared/messages.ts';
import { STATUS_LABELS, type Status } from '../shared/types.ts';
import { reconcile } from './registration.ts';

const COLORS: Readonly<Record<Status, string>> = { low: '#10B981', review: '#F59E0B', high: '#EF4444' };
const IDLE_TITLE = 'SlopMachine: no supported editor focused';

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

async function clearBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: IDLE_TITLE });
}

chrome.runtime.onMessage.addListener((raw, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (SyncSitesSchema.safeParse(raw).success) {
    reconcile(true).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }

  const tabId = sender.tab?.id;
  const parsed = BroadcastSchema.safeParse(raw);
  if (tabId === undefined || !parsed.success) return false;
  const msg = parsed.data;

  if (msg.type === 'analysis/cleared' || !msg.eligible) {
    void clearBadge(tabId);
  } else {
    void chrome.action.setBadgeText({ tabId, text: String(msg.score) });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS[msg.status] });
    void chrome.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' });
    void chrome.action.setTitle({ tabId, title: `SlopMachine: ${STATUS_LABELS[msg.status].toLowerCase()} (${msg.score}/100)` });
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => void reconcile(true));
chrome.runtime.onStartup.addListener(() => void reconcile(false));
chrome.permissions.onAdded.addListener(() => void reconcile(true));
chrome.permissions.onRemoved.addListener(() => void reconcile(false));
