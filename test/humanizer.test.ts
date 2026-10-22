// Examples adapted from blader/humanizer (MIT), itself based on Wikipedia's "Signs of AI writing".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Purpose } from '../src/shared/prompt.ts';
import { analyze } from '../src/shared/rules/engine.ts';

const S = { mutedRules: [], allowList: [], customPhrases: [] };
const rules = (text: string, purpose: Purpose = 'content') => analyze(text, { ...S, purpose }).issues.map((i) => i.ruleId);
const fires = (id: string, text: string, purpose?: Purpose) => assert.ok(rules(text, purpose).includes(id), `${id} should fire on: ${text}`);
const quiet = (id: string, text: string, purpose?: Purpose) => assert.ok(!rules(text, purpose).includes(id), `${id} should not fire on: ${text}`);
const fixed = (text: string, id: string) => {
  const i = analyze(text, { ...S, purpose: 'content' }).issues.find((x) => x.ruleId === id)!;
  return text.slice(0, i.fix!.start) + i.fix!.replacement + text.slice(i.fix!.end);
};

test('§1 not X but Y, including the split and clipped forms', () => {
  fires('not-x-but-y', "It's not just about the beat; it's part of the atmosphere.");
  fires('not-x-but-y', 'It is not merely a song, but a statement.');
  fires('not-x-but-y', 'This does not mean every choice is equal. It means no system confirms which is right.');
  fires('not-x-but-y', 'The options come from the selected item, no guessing.');
  fires('not-x-but-y', "Onboarding isn't just a checklist, it's a culture.");
  quiet('not-x-but-y', 'The release does not include the new importer.');
});

test('§2 closers and fragment rows, but not a sign-off', () => {
  fires('closer', 'Caching cuts repeat work. That is the real win.');
  fires('closer', 'Read that again.');
  fires('closer', 'It had no preference for symmetry. No aesthetic prior. No nostalgia. No rules.');
  fires('closer', 'We shipped it every. single. day.');
  quiet('closer', 'Thanks.\nTalk soon.\nSam.');
  assert.equal(fixed('Caching cuts repeat work. Let that sink in.', 'closer'), 'Caching cuts repeat work. ');
});

test('§3–§5 deep sayings, run-ups and arguing with no one', () => {
  fires('deep-saying', 'At its core, what really matters is organizational readiness.');
  fires('run-up', "Let's dive into how caching works. Here's what you need to know.");
  fires('run-up', 'Is it worth it? Honestly? It depends.');
  fires('strawman', "I'm not saying documentation doesn't matter.");
  assert.equal(fixed("Here's the thing: caching is per request.", 'run-up'), 'Caching is per request.');
  quiet('run-up', 'Look at the logs before you restart.', 'docs');
});

test('§6 §8 §9 weak alone: they need company', () => {
  const oneDash = 'The new policy — announced in May — affects thousands of workers.';
  quiet('dashes', oneDash, 'docs');
  fires('dashes', `${oneDash} The changes — long overdue — start now.`, 'docs');
  fires('dashes', `${oneDash} Let that sink in.`, 'docs');
  quiet('qualifiers', 'The policy could potentially affect outcomes.');
  fires('qualifiers', 'The policy could potentially affect outcomes. It might arguably help.');
  quiet('triads', 'We offer email, chat, and phone support.');
});

test('§10 hyphen after the noun, kept before it', () => {
  fires('hyphen-pair', 'The report is high-quality and the plan is long-term.');
  quiet('hyphen-pair', 'A high-quality report and a long-term plan.');
  assert.equal(fixed('The report is high-quality and the plan is long-term.', 'hyphen-pair'), 'The report is high quality and the plan is long-term.');
});

test('§12 §13 §16 §18 word-level tells with swaps', () => {
  for (const t of ['Additionally, the team grew.', 'It plays a key role in growth.', 'Nestled in the hills, the town is quiet.', 'Gallery 825 serves as the main space.', 'It boasts four rooms.']) {
    fires('phrase', t);
  }
  const t = 'Gallery 825 serves as the main space.';
  const i = analyze(t, S).issues.find((x) => x.ruleId === 'phrase')!;
  assert.equal(t.slice(0, i.fix!.start) + i.fix!.replacement + t.slice(i.fix!.end), 'Gallery 825 is the main space.');
  quiet('phrase', 'Rename the field to use an underscore.', 'docs');
});

test('§15 -ing riders are cut back to the plain fact', () => {
  const t = 'The temple is painted blue and gold, symbolizing the region’s natural beauty.';
  fires('ing-rider', t);
  assert.equal(fixed(t, 'ing-rider'), 'The temple is painted blue and gold.');
});

test('§17 unnamed authority, §14 vague link (weak)', () => {
  fires('borrowed-authority', 'Experts believe it plays a role in the ecosystem.');
  quiet('vague-link', 'He is associated with the orchestra.');
  fires('vague-link', 'He is associated with the orchestra. Let that sink in.');
});

test('§19 §20 formatting by rule', () => {
  fires('bold-labels', '- **Performance:** Faster.\n- **Security:** Safer.\n- **UX:** Nicer.');
  fires('decorated-headings', '## Strategic Negotiations And Global Partnerships\nText.');
  fires('decorated-headings', '🚀 Launch phase starts in Q3.');
  quiet('decorated-headings', '## Strategic negotiations and global partnerships\nText.');
});

test('§22 §23 leftovers are critical and removable; sales emails keep their asks', () => {
  const t = 'Great question! The revolution began in 1789. I hope this helps.';
  const r = analyze(t, { ...S, purpose: 'content' });
  assert.ok(r.issues.some((i) => i.ruleId === 'chat-residue' && i.severity === 'critical'));
  assert.equal(fixed(t, 'chat-residue'), 'The revolution began in 1789. I hope this helps.');
  fires('knowledge-limit', 'Her early life is not publicly available, suggesting she maintains a low profile.');
  quiet('chat-residue', 'Would you like me to send the deck before Thursday?', 'outreach');
  fires('chat-residue', 'Would you like me to expand any section?', 'content');
});

test('§25 writing about the document, docs only', () => {
  fires('meta-text', 'The table below compares each plan. This section is organized by owner.', 'docs');
  quiet('meta-text', 'The table below compares each plan.', 'outreach');
});

test('when not to act: quoted text is left alone', () => {
  quiet('closer', 'The poster said "Let that sink in." and nothing else.');
});

test('a heavily AI-sounding paragraph scores high; a plain one stays low', () => {
  const slop = "Great question! In today's fast-paced world, it's not just a tool — it's a mindset. Let's dive in. At its core, the platform serves as a testament to innovation, highlighting its commitment to excellence. Experts believe it plays a crucial role in growth. Let that sink in.";
  assert.equal(analyze(slop, { ...S, purpose: 'content' }).status, 'high');
  const plain = 'We moved the import button to the toolbar. It now accepts CSV files up to 50 MB, and a progress bar shows how far along the upload is.';
  assert.equal(analyze(plain, { ...S, purpose: 'docs' }).status, 'low');
});
