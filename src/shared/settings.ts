import * as z from 'zod/mini';
import { RemoteModelSchema, type Vendor } from './byok/types.ts';
import { secretDelete, secretGet, secretSet } from './keystore.ts';
import { SITE_PATTERN } from './sites.ts';

export const SITES = [
  {
    id: 'gmail',
    label: 'Gmail',
    matches: ['https://mail.google.com/*'],
    reason: 'Reads the message box you are typing in on mail.google.com. Nothing else on the page.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    matches: ['https://*.linkedin.com/*'],
    reason: 'Reads the message or post box you are typing in on linkedin.com.',
  },
] as const;

export type SiteId = (typeof SITES)[number]['id'];

export const LOOPBACK_ORIGINS = ['http://localhost/*', 'http://127.0.0.1/*'] as const;

const SettingsSchema = z.object({
  version: z.literal(1),
  sites: z.object({ gmail: z.boolean(), linkedin: z.boolean() }),
  genericOrigins: z.array(z.string().check(z.regex(SITE_PATTERN))),
  minWords: z.number().check(z.int(), z.gte(5), z.lte(200)),
  mutedRules: z.array(z.string()),
  allowList: z.array(z.string()),
  customPhrases: z.array(z.string()),
  purpose: z.enum(['outreach', 'marketing', 'content', 'docs']),
  provider: z.enum(['none', 'builtin', 'local', 'byok']),
  /** Run the AI review by itself when the panel opens (never past a consent the user hasn't given). */
  aiAuto: z.boolean(),
  /** Remote providers the user said not to ask about again before each send. */
  trustedVendors: z.array(z.enum(['openai', 'anthropic', 'google'])),
  local: z.object({ baseUrl: z.string().check(z.regex(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/)), model: z.string() }),
  byok: z.object({
    vendor: z.enum(['openai', 'anthropic', 'google']),
    rememberKey: z.boolean(),
    // The chosen model per vendor, picked from the list the user's key returns.
    models: z.object({ openai: z.nullable(RemoteModelSchema), anthropic: z.nullable(RemoteModelSchema), google: z.nullable(RemoteModelSchema) }),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderId = Settings['provider'];

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  sites: { gmail: false, linkedin: false },
  genericOrigins: [],
  minWords: 25,
  mutedRules: [],
  allowList: [],
  customPhrases: [],
  purpose: 'outreach',
  provider: 'none',
  aiAuto: true,
  trustedVendors: [],
  local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  byok: { vendor: 'openai', rememberKey: false, models: { openai: null, anthropic: null, google: null } },
};

/** Validates untrusted input (storage or an imported file). Invalid → null, never a partial merge. */
export function parseSettings(raw: unknown): Settings | null {
  const r = SettingsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Settings saved by an older build: keep every field that is still valid and default the rest,
 * so adding a field (or tightening one) never silently turns the user's sites off.
 */
export function coerceSettings(raw: unknown): Settings {
  const strict = parseSettings(raw);
  if (strict || typeof raw !== 'object' || raw === null) return strict ?? DEFAULT_SETTINGS;
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [key, schema] of Object.entries(SettingsSchema.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    if (key !== 'version' && schema.safeParse(value).success) merged[key] = value;
  }
  return parseSettings(merged) ?? DEFAULT_SETTINGS;
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return coerceSettings(settings);
}

export async function saveSettings(next: Settings): Promise<void> {
  const valid = parseSettings(next);
  if (!valid) throw new Error('Settings did not validate.');
  await chrome.storage.local.set({ settings: valid });
}

export async function updateSettings(patch: (s: Settings) => Settings): Promise<Settings> {
  const next = patch(await loadSettings());
  await saveSettings(next);
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) cb(coerceSettings(changes['settings']?.newValue));
  });
}

const keyName = (v: Vendor) => `key:${v}`;

/** API key: session storage (trusted contexts only) unless the user opted into saving it on this device. */
export async function loadKey(vendor: Vendor): Promise<string> {
  const name = keyName(vendor);
  const s = await chrome.storage.session.get(name);
  if (typeof s[name] === 'string') return s[name];
  const saved = await secretGet(name);
  return typeof saved === 'string' ? saved : '';
}

export async function storeKey(vendor: Vendor, key: string, remember: boolean): Promise<void> {
  const name = keyName(vendor);
  await chrome.storage.session.remove(name);
  await secretDelete(name);
  if (!key) return;
  if (remember) await secretSet(name, key);
  else await chrome.storage.session.set({ [name]: key });
}
