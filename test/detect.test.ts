import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/shared/detect/chunks.ts';
import { detectAuthorship } from '../src/shared/detect/detect.ts';
import { addTokenStats, emptyStats, lmFeatures } from '../src/shared/detect/lm.ts';
import { displayScore, probability, type LogReg } from '../src/shared/detect/model.ts';
import { normalizeForDetection, unmask } from '../src/shared/detect/normalize.ts';
import { STYLE_FEATURES, styleFeatures } from '../src/shared/detect/stylometry.ts';
import { DETECTORS } from '../src/shared/detect/weights.ts';
import { parseReview } from '../src/shared/review.ts';
import { analyze } from '../src/shared/rules/engine.ts';

const S = { mutedRules: [], allowList: [], customPhrases: [] };
const AI = `In today's rapidly evolving digital landscape, organizations must leverage cutting-edge solutions to remain competitive. Our comprehensive platform empowers teams to streamline workflows, foster collaboration, and unlock unprecedented growth.

Moreover, by harnessing the power of artificial intelligence, businesses can make data-driven decisions with confidence. This seamless integration ensures that every stakeholder remains aligned, informed, and engaged throughout the process.

Ultimately, embracing this transformative approach is not just a strategic advantage; it is a necessity for sustainable success in an increasingly dynamic marketplace.`;
const HUMAN = `ok so the dryer died again. third time since march. the guy from sears says it's the thermal fuse, a $14 part, but he wants $120 to come put it in which is insane.

i'm just gonna order the fuse off amazon and youtube it, how hard can it be. Dave did ours in like 20 min last year and he can barely change a lightbulb.

if the house burns down you'll know why. anyway, are we still on for saturday? i can bring the cooler and the chairs if Mike's got the grill.`;

test('normalization strips zero-width characters and Latin look-alikes, and counts them', () => {
  const n = normalizeForDetection('Pl​ease pаy the inv‍oice.');
  assert.equal(n.text, 'Please pay the invoice.');
  assert.equal(n.invisible, 2);
  assert.equal(n.homoglyphs, 1);
  assert.equal(normalizeForDetection('Привет, мир').homoglyphs, 0, 'a real Russian word is not a look-alike trick');
  assert.equal(unmask('pаy​'), 'pay');
});

test('chunks merge short paragraphs and keep offsets into the original', () => {
  const text = `Hi Sam,\n\n${'word '.repeat(45).trim()}\n\nThanks!\n\n${'more '.repeat(60).trim()}`;
  const chunks = chunkText(text);
  assert.equal(chunks.length, 2);
  for (const c of chunks) assert.equal(text.slice(c.start, c.end), c.text);
  assert.ok(chunks[0]!.text.startsWith('Hi Sam'), 'greeting merged into the first passage');
});

test('token statistics match hand-computed values on toy logits', () => {
  // Vocab of 3, uniform observer and performer: every token is equally likely.
  const s = emptyStats();
  addTokenStats(s, [0, 1, 2], new Float32Array(9), new Float32Array(9), 3);
  const f = lmFeatures(s);
  assert.ok(Math.abs(f.lm_nll_obs - Math.log(3)) < 1e-6);
  assert.ok(Math.abs(f.lm_entropy - Math.log(3)) < 1e-6);
  assert.ok(Math.abs(f.binoculars - 1) < 1e-6, 'identical models give a Binoculars score of 1');
  // Observer sure of the right token: low surprise, low entropy; uniform performer: cross-entropy ln 3.
  const t = emptyStats();
  addTokenStats(t, [0, 2], new Float32Array([0, 0, 10]), new Float32Array(3), 3);
  assert.ok(t.nllObs[0]! < 0.001);
  assert.ok(t.entropy[0]! < 0.01);
  assert.ok(Math.abs(t.xent[0]! - Math.log(3)) < 1e-6);
});

test('model clips out-of-range inputs and ignores non-finite values', () => {
  const m: LogReg = { kind: 'logreg', features: ['x'], mean: [0], scale: [1], weights: [1], bias: 0, aiAt: 0.9, leanAt: 0.5, humanAt: 0.1 };
  assert.equal(probability(m, { x: 1e9 }), probability(m, { x: 5 }));
  assert.equal(probability(m, { x: Number.NaN }), 0.5);
});

test('style features are finite for odd input', () => {
  for (const text of ['', '12 34 56', '!!!', 'word']) {
    const f = styleFeatures(text);
    for (const k of STYLE_FEATURES) assert.ok(Number.isFinite(f[k]), `${k} on ${JSON.stringify(text)}`);
  }
});

test('trained tiers have ordered thresholds and trust the classifier in the right direction', () => {
  for (const [tier, m] of Object.entries(DETECTORS)) {
    assert.ok(m.humanAt > 0 && m.humanAt <= m.leanAt && m.leanAt <= m.aiAt && m.aiAt < 1, tier);
    assert.equal(m.features.length, m.mean.length);
  }
  const avg = (m: (typeof DETECTORS)['classifier']) => Object.fromEntries(m.features.map((f, i) => [f, m.mean[i]!]));
  for (const [tier, f] of [['fast', 'ft_logit'], ['classifier', 'ft_logit'], ['classifier', 'cls_logit'], ['full', 'ft_logit'], ['full', 'cls_logit']] as const) {
    const m = DETECTORS[tier];
    assert.ok(probability(m, { ...avg(m), [f]: 8 }) > probability(m, { ...avg(m), [f]: -8 }), `${tier}: higher ${f}, more likely AI`);
  }
});

test('score always agrees with its band', () => {
  for (const m of Object.values(DETECTORS)) {
    for (let p = 0; p <= 1; p += 0.001) {
      const s = displayScore(m, p);
      const band = p >= m.aiAt ? 'ai' : p >= m.leanAt ? 'lean' : p < m.humanAt ? 'human' : 'unclear';
      const expected = band === 'ai' ? s >= 80 : band === 'lean' ? s >= 60 && s < 80 : band === 'unclear' ? s >= 30 && s < 60 : s < 30;
      assert.ok(expected, `p ${p.toFixed(3)} → ${s} (${band})`);
    }
  }
});

test('authorship estimate: short text is not judged, longer text gets a band, passages and reasons', () => {
  const short = detectAuthorship('Thanks, see you Thursday.');
  assert.equal(short.band, 'short');
  assert.equal(short.score, null);

  const ai = detectAuthorship(AI);
  const human = detectAuthorship(HUMAN);
  assert.equal(ai.tier, 'instant', 'no model evidence yet: style statistics only');
  assert.ok(ai.score! > human.score!, `${ai.score} vs ${human.score}`);
  assert.equal(ai.passages.length, 0, 'short paragraphs merge into one passage, so no breakdown');
  assert.ok(ai.reasons.length > 0);

  // A pasted AI paragraph followed by a person's own: the breakdown should tell them apart.
  const mixed = `${AI.replace(/\n\n/g, ' ')}\n\n${HUMAN.replace(/\n\n/g, ' ')}`;
  const m = detectAuthorship(mixed);
  assert.equal(m.passages.length, 2);
  for (const p of m.passages) assert.ok(p.start >= 0 && p.end <= mixed.length && p.end > p.start);
  assert.ok(m.passages[0]!.score > m.passages[1]!.score);
  assert.equal(ai.lowConfidence, true, 'under 150 words');
});

test('model evidence moves the estimate and selects the tier', () => {
  const lo = detectAuthorship(AI, { doc: { ft: -8 }, chunks: [] });
  const hi = detectAuthorship(AI, { doc: { ft: 8 }, chunks: [] });
  assert.equal(hi.tier, 'fast');
  assert.ok(hi.score! > lo.score!);
  assert.equal(detectAuthorship(AI, { doc: { ft: 0, cls: 0 }, chunks: [] }).tier, 'classifier');
});

test('hidden characters are flagged once, with a fix that cleans them', () => {
  const text = 'Our pl​atform is the best way to pаy vendors on time every month.';
  const issue = analyze(text, S).issues.find((i) => i.ruleId === 'hidden-chars');
  assert.ok(issue?.fix);
  const fixed = text.slice(0, issue.fix.start) + issue.fix.replacement + text.slice(issue.fix.end);
  assert.equal(fixed, 'Our platform is the best way to pay vendors on time every month.');
});

test('AI review carries an authorship opinion when the engine gives one', () => {
  const r = parseReview('{"overall":"ok","authorship":{"rating":"AI","reason":"Stock transitions throughout."},"findings":[]}')!;
  assert.deepEqual(r.authorship, { rating: 'ai', reason: 'Stock transitions throughout.' });
  assert.equal(parseReview('{"overall":"ok","authorship":{"rating":"maybe"},"findings":[]}')!.authorship, undefined);
});

test('every reason shown points the way the research says', async () => {
  const { AI_SIDE, REASON_LABELS } = await import('../src/shared/detect/reasons.ts');
  for (const text of [AI, HUMAN, `${AI}\n\n${HUMAN}`]) {
    for (const ev of [undefined, { doc: { ft: 6 }, chunks: [] }, { doc: { ft: -6 }, chunks: [] }]) {
      for (const r of detectAuthorship(text, ev).reasons.filter((x) => x.kind !== 'pattern')) {
        const f = Object.keys(REASON_LABELS).find((k) => REASON_LABELS[k]!.includes(r.text))!;
        const highText = REASON_LABELS[f]![0] === r.text;
        assert.equal(highText === (AI_SIDE[f] === 'high'), r.leansAi, `${f}: "${r.text}" shown as ${r.leansAi ? 'AI' : 'person'}`);
      }
    }
  }
});

test('a local server that lacks the model says which model', async () => {
  const { completeOpenAICompatible, ProviderError } = await import('../src/shared/providers.ts');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"model not found"}', { status: 404 });
  try {
    await assert.rejects(
      completeOpenAICompatible({ label: 'Your local model', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' }, { system: 's', user: 'u' }, new AbortController().signal),
      (e: unknown) => e instanceof ProviderError && /no model named “llama3\.2”/.test(e.message),
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('page text: headings and table rows are separate paragraphs; targets are not claims; label templates are named', async () => {
  const { analyze } = await import('../src/shared/rules/engine.ts');
  const table = 'Roadmap Planning\n\nCurrent State\n\n' + Array.from({ length: 12 }, (_, i) => `Activity ${i} | L1 | L3 | Engineer manually reads the document and maps it`).join('\n\n');
  assert.ok(!analyze(table, S).issues.some((i) => i.ruleId === 'wall-of-text'), 'blank-line separated rows are not one long paragraph');
  const target = 'Success criteria: at least 80% of outputs are rated useful by reviewing engineers within the first quarter.';
  assert.ok(!analyze(target, S).issues.some((i) => i.ruleId === 'numeric-claim'));
  assert.ok(analyze('Our clients saw over 43% more replies last quarter.', S).issues.some((i) => i.ruleId === 'numeric-claim'), 'a result still needs a source');
  const doc = ['What it does: finds services.', 'Why it matters: saves time.', 'What it does: reads code.', 'Why it matters: fewer meetings.', 'What it does: estimates work.'].join('\n');
  const label = analyze(doc, S).issues.find((i) => i.ruleId === 'label-template');
  assert.match(label!.title, /“What it does:” and “Why it matters:”/);
  assert.ok(analyze('Subject: Thursday\nDate: 12 May\nHi Sam, can we move our call to 3pm?', S).issues.every((i) => i.ruleId !== 'label-template'), 'ordinary email headers are fine');
  const reasons = detectAuthorship(`${AI}\n\n${doc}\n${doc}`).reasons;
  assert.ok(reasons.some((r) => r.kind === 'pattern' && /label template/.test(r.text)));
});
