// Downloads the public evaluation corpora into .cache/detector/raw/*.jsonl as {text, label, source, ...}.
// label: 0 = human, 1 = AI. Re-running skips files that already exist; delete one to refetch it.
// Sources: MAGE (yaful/MAGE), RAID (liamdugan/raid), HC3 (Hello-SimpleAI/HC3), Enron emails
// (corbt/enron-emails), and Liang et al. "GPT detectors are biased against non-native English writers".
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const OUT = '.cache/detector/raw';
const DS = 'https://datasets-server.huggingface.co';
const LIANG = 'https://raw.githubusercontent.com/Weixin-Liang/ChatGPT-Detector-Bias/main/Data_and_Results/Human_Data';

// ponytail: fixed-seed LCG so a refetch picks the same windows; swap for a real PRNG if it ever matters.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (t) => t.trim().split(/\s+/).length;
const okLength = (t) => words(t) >= 40 && words(t) <= 900;

async function get(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && !body.error) return body;
      if (i >= tries) throw new Error(`${res.status} ${body.error ?? ''} ${url}`);
    } catch (e) {
      if (i >= tries) throw e;
    }
    await sleep(2000 * (i + 1));
  }
}

const rows = async (dataset, config, split, offset, length = 100) =>
  (await get(`${DS}/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`)).rows.map((r) => r.row);

async function total(dataset, config, split) {
  return (await get(`${DS}/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=0&length=1`)).num_rows_total;
}

/**
 * Random 100-row windows until every (group, label) cell holds `want` rows, so no genre is mostly
 * human or mostly AI: a model must not be able to score well by recognising the genre.
 */
async function sample(dataset, config, split, want, map, group = () => 'all', maxCalls = 350) {
  const n = await total(dataset, config, split);
  const kept = new Map();
  const seen = new Set();
  const full = () => kept.size > 0 && [...kept.values()].every((c) => c.length >= want);
  for (let calls = 0; calls < maxCalls && !(full() && kept.size >= 2 * new Set([...kept.keys()].map((k) => k.split(':')[0])).size); calls++) {
    const offset = Math.floor(rand() * (n - 100));
    let batch;
    try {
      batch = await rows(dataset, config, split, offset);
    } catch (e) {
      console.warn(`\n  ${dataset}: stopping early (${e.message.slice(0, 40)}); keeping what was sampled`);
      break;
    }
    for (const raw of batch) {
      const r = map(raw);
      if (!r || !okLength(r.text) || seen.has(r.text)) continue;
      const key = `${group(r)}:${r.label}`;
      const cell = kept.get(key) ?? [];
      if (cell.length >= want) continue;
      seen.add(r.text);
      cell.push(r);
      kept.set(key, cell);
    }
    process.stdout.write(`\r  ${dataset} ${split}: ${[...kept.entries()].map(([k, v]) => `${k} ${v.length}`).join(', ')}   `);
  }
  process.stdout.write('\n');
  // Keep only groups that have both labels.
  const groups = [...new Set([...kept.keys()].map((k) => k.split(':')[0]))];
  return groups.filter((g) => kept.has(`${g}:0`) && kept.has(`${g}:1`)).flatMap((g) => {
    const m = Math.min(kept.get(`${g}:0`).length, kept.get(`${g}:1`).length);
    return [...kept.get(`${g}:0`).slice(0, m), ...kept.get(`${g}:1`).slice(0, m)];
  });
}
const mageDomain = (r) => r.meta.split('_')[0];

const mage = (src) => (r) => ({ text: r.text, label: /human/.test(r.src) ? 0 : 1, source: src, meta: r.src });
const raidMap = (attacked) => (r) => {
  if (attacked ? r.attack === 'none' : r.attack !== 'none') return null;
  if (r.model === 'gpt2') return null; // 2019 sampling artifacts; not a model anyone drafts email with
  return { text: r.generation, label: r.model === 'human' ? 0 : 1, source: attacked ? 'raid-adversarial' : 'raid', meta: `${r.model}/${r.domain}/${r.attack}` };
};

function hc3(r) {
  const parse = (v) => (Array.isArray(v) ? v : []);
  const h = parse(r.human_answers)[0];
  const a = parse(r.chatgpt_answers)[0];
  return [h && { text: h, label: 0, source: 'hc3', meta: r.source }, a && { text: a, label: 1, source: 'hc3', meta: r.source }].filter(Boolean);
}

async function liang(dir, label, source) {
  const docs = await (await fetch(`${LIANG}/${dir}/data.json`)).json();
  // The commercial detectors' verdicts on the same essays, for comparison in the report.
  const gptzero = await (await fetch(`${LIANG}/${dir}/GPTZero.json`)).json().catch(() => null);
  return docs.map((d, i) => ({ text: d.document, label, source, meta: dir, gptzero: gptzero?.[i] ?? null }));
}

const JOBS = {
  'mage-train': () => sample('yaful/MAGE', 'default', 'train', 80, mage('mage'), mageDomain),
  'mage-test': () => sample('yaful/MAGE', 'default', 'test', 45, mage('mage'), mageDomain),
  'raid-train': () => sample('liamdugan/raid', 'raid', 'train', 450, raidMap(false)),
  'raid-adversarial': () => sample('liamdugan/raid', 'raid', 'train', 300, raidMap(true)),
  hc3: async () => {
    const n = await total('Hello-SimpleAI/HC3', 'all', 'train');
    const out = [];
    while (out.length < 400) out.push(...(await rows('Hello-SimpleAI/HC3', 'all', 'train', Math.floor(rand() * (n - 20)), 20)).flatMap(hc3).filter((r) => okLength(r.text)));
    return out;
  },
  enron: async () => {
    const n = await total('corbt/enron-emails', 'default', 'train');
    const out = [];
    while (out.length < 2000) {
      for (const r of await rows('corbt/enron-emails', 'default', 'train', Math.floor(rand() * (n - 100)))) {
        // Original messages only: forwarded chains and replies quote other people.
        const body = (r.body ?? '').split(/-----Original Message-----|-{3,} ?Forwarded by|\n>/)[0].trim();
        if (okLength(body) && words(body) <= 400 && out.length < 2000) out.push({ text: body, label: 0, source: 'enron', meta: r.subject });
      }
    }
    return out;
  },
  'liang-nonnative': async () => [
    ...(await liang('TOEFL_real_91', 0, 'toefl-human')),
    ...(await liang('TOEFL_gpt4polished_91', 1, 'toefl-gpt4-polished')),
    ...(await liang('HewlettStudentEssay_real_88', 0, 'us-student-human')),
    ...(await liang('CollegeEssay_real_70', 0, 'college-essay-human')),
  ],
  // Training-only: written by Sonnet and Haiku from separate prompts, so Opus stays an unseen model in domain-ai.
  'domain-ai-train': async () => (await readFile('scripts/detector/data/domain_ai_train.jsonl', 'utf8')).trim().split('\n').map((l) => {
    const d = JSON.parse(l);
    return { text: d.text, label: 1, source: 'claude-domain-train', meta: `${d.model}/${d.purpose}/${d.style}` };
  }),
  // Training-only: Sonnet and Haiku told to pass as human (plus some plain docs and essays), from separate prompts.
  'humanlike-train': async () => (await readFile('scripts/detector/data/humanlike_train.jsonl', 'utf8')).trim().split('\n').map((l) => {
    const d = JSON.parse(l);
    return { text: d.text, label: 1, source: 'claude-humanlike', meta: `${d.model}/${d.purpose}/${d.tactic}` };
  }),
  'domain-ai': async () => (await readFile('scripts/detector/data/domain_ai.jsonl', 'utf8')).trim().split('\n').map((l) => {
    const d = JSON.parse(l);
    return { text: d.text, label: 1, source: 'claude-domain', meta: `${d.model}/${d.purpose}/${d.style}` };
  }),
};

await mkdir(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const [name, job] of Object.entries(JOBS)) {
  if (only.length && !only.includes(name)) continue;
  const file = `${OUT}/${name}.jsonl`;
  if (existsSync(file)) { console.log(`  ${name}: cached`); continue; }
  try {
    const recs = await job();
    await writeFile(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`  ${name}: ${recs.length} rows`);
  } catch (e) {
    console.error(`  ${name}: FAILED ${e.message}`);
    process.exitCode = 1;
  }
}
