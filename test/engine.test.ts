import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/shared/rules/engine.ts';
import { FAMILY_CAPS } from '../src/shared/types.ts';

const S = { mutedRules: [], allowList: [], customPhrases: [] };
const MOCKUP = `Hi {{first_name}},

In today’s fast-paced business landscape, driving operational efficiency is paramount. We delve deep into our client’s operational friction points to spearhead transformative growth. Our tailored, cutting-edge solution stands as a testament to our commitment to elevate pipeline momentum.

Moreover, our clients have experienced upwards of 43% synergy gains within their first quarter. [Insert company observation or recent news item here].

I would love to arrange a brief introductory call next Tuesday. Let’s connect!

Best regards,
Outbound Specialist`;

const CLEAN = `Hi Alex, I saw your team posted three SDR roles in Austin last week. When reps ramp that fast, first emails tend to drift into template language. We built a checker that flags leftover merge tags before anything goes out. Could I send you a two-minute screen recording on Thursday?`;

test('mockup draft scores high with explainable issues', () => {
  const r = analyze(MOCKUP, S);
  assert.equal(r.status, 'high');
  assert.equal(r.score, r.issues.reduce((a, i) => a + i.points, 0), 'score is the sum of issue points');
  const rules = new Set(r.issues.map((i) => i.ruleId));
  for (const id of ['placeholder', 'phrase', 'numeric-claim', 'vague-cta']) assert.ok(rules.has(id), id);
});

test('clean draft scores low', () => {
  const r = analyze(CLEAN, S);
  assert.equal(r.status, 'low', JSON.stringify(r.issues.map((i) => i.title)));
});

test('placeholder issue appears, then disappears once replaced (acceptance §8)', () => {
  const draft = `Hi {{first_name}}, ${CLEAN}`;
  assert.ok(analyze(draft, S).issues.some((i) => i.ruleId === 'placeholder'));
  assert.ok(!analyze(draft.replace('{{first_name}}', 'Alex'), S).issues.some((i) => i.ruleId === 'placeholder'));
});

test('family caps hold and total never exceeds 100', () => {
  const spam = Array.from({ length: 40 }, (_, i) => `{{tag_${i}}} delve synergy leverage 50% let's connect.`).join(' ');
  const r = analyze(spam, S);
  assert.ok(r.score <= 100);
  for (const [fam, pts] of Object.entries(r.byFamily)) assert.ok(pts <= FAMILY_CAPS[fam as keyof typeof FAMILY_CAPS], fam);
  assert.ok(r.issues.some((i) => i.points === 0), 'issues past the cap stay visible');
});

test('deterministic and offsets point at the matched text', () => {
  const a = analyze(MOCKUP, S);
  assert.deepEqual(a, analyze(MOCKUP, S));
  const tag = a.issues.find((i) => i.ruleId === 'placeholder')!;
  assert.equal(MOCKUP.slice(tag.start, tag.end), '{{first_name}}');
});

test('muted rules, allow-list, custom phrases and dismissed keys', () => {
  assert.ok(!analyze(MOCKUP, { ...S, mutedRules: ['placeholder'] }).issues.some((i) => i.ruleId === 'placeholder'));
  assert.ok(!analyze('We delve into it.', { ...S, allowList: ['delve into'] }).issues.length);
  assert.equal(analyze('This is a rocket ship.', { ...S, customPhrases: ['rocket ship'] }).issues[0]?.ruleId, 'phrase');
  const keys = new Set(['phrase:delve into']);
  assert.ok(!analyze('We delve into it.', S, undefined, keys).issues.length);
});

test('quoted text is not flagged as a stock phrase', () => {
  assert.ok(!analyze('Their slogan is "a cutting-edge platform" and it shows.', S).issues.some((i) => i.ruleId === 'phrase'));
});

test('stock phrase fixes produce readable text', () => {
  const text = 'In today’s fast-paced world, sales is hard. We leverage data.';
  const r = analyze(text, S);
  const apply = (id: string) => {
    const f = r.issues.find((i) => text.slice(i.start, i.end).toLowerCase().startsWith(id))!.fix!;
    return text.slice(0, f.start) + f.replacement + text.slice(f.end);
  };
  assert.equal(apply('in today'), 'Sales is hard. We leverage data.');
  assert.equal(apply('leverage'), 'In today’s fast-paced world, sales is hard. We use data.');
});

test('empty opener has a removal fix', () => {
  const text = `Hi Sam,\n\nI hope this email finds you well. ${CLEAN}`;
  const o = analyze(text, S).issues.find((i) => i.ruleId === 'opener')!;
  assert.ok(o.fix);
  assert.equal(text.slice(0, o.fix.start) + text.slice(o.fix.end), `Hi Sam,\n\n${CLEAN}`);
});

test('numeric claim with a source is not flagged', () => {
  assert.ok(!analyze('According to the 2024 Gartner survey, 43% of teams agree.', S).issues.length);
});

test('edit-after-paste indicator', () => {
  const sig = { largestPasteChars: CLEAN.length, editedCharsSincePaste: 0 };
  assert.ok(analyze(CLEAN, S, sig).issues.some((i) => i.ruleId === 'paste'));
  assert.ok(!analyze(CLEAN, S, { ...sig, editedCharsSincePaste: 40 }).issues.some((i) => i.ruleId === 'paste'));
});

test('markdown links are not placeholders', () => {
  assert.ok(!analyze('See [Docs](https://x.y) for details.', S).issues.length);
});

test('1,000 words analyze well under the 75 ms budget', () => {
  const big = Array.from({ length: 70 }, () => CLEAN).join('\n\n').slice(0, 12_000);
  const t = performance.now();
  analyze(big, S);
  assert.ok(performance.now() - t < 75);
});

test('rules follow what the text is', () => {
  const docs = 'To install, simply run the script. Obviously you need Node first.';
  assert.ok(analyze(docs, { ...S, purpose: 'docs' }).issues.some((i) => i.ruleId === 'phrase'));
  assert.ok(!analyze(docs, { ...S, purpose: 'outreach' }).issues.some((i) => i.ruleId === 'phrase'), '"simply" is fine in an email');

  const ask = "Thanks for reading. Let's connect!";
  assert.ok(analyze(ask, { ...S, purpose: 'marketing' }).issues.some((i) => i.ruleId === 'vague-cta'));
  assert.ok(!analyze(ask, { ...S, purpose: 'content' }).issues.some((i) => i.ruleId === 'vague-cta'), 'posts are not judged on their ask');

  const post = 'In this article, we will look at three ways teams onboard reps faster.';
  assert.ok(analyze(post, { ...S, purpose: 'content' }).issues.some((i) => i.ruleId === 'opener'));
});
