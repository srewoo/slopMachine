"""Human long-form prose for training, so polished human writing is not mistaken for AI.

Download first, into .cache/detector/src/:
    mage-train-0.parquet https://huggingface.co/datasets/yaful/MAGE/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet
    wikitext-0.parquet   https://huggingface.co/datasets/Salesforce/wikitext/resolve/refs%2Fconvert%2Fparquet/wikitext-103-raw-v1/train/0000.parquet
    hc3-all.parquet      https://huggingface.co/datasets/Hello-SimpleAI/HC3/resolve/refs%2Fconvert%2Fparquet/all/train/0000.parquet

MAGE (Apache-2.0): human and AI text per domain, balanced, incl. r/ChangeMyView arguments, stories, news.
WikiText-103 (CC BY-SA): Wikipedia paragraphs. HC3 (CC BY-SA): human and ChatGPT answers; half by
question trains, the other half replaces hc3.jsonl as the evaluation set.
WikiText and HC3 put spaces around punctuation ("word , word"); both labels are detokenized alike,
so spacing can't give the label away.
Writes .cache/detector/raw/longform-train.jsonl and hc3.jsonl. Usage: python3 scripts/detector/fetch_longform.py
"""
import hashlib
import json
import random
import re

import pyarrow.parquet as pq

SRC = ".cache/detector/src"
RAW = ".cache/detector/raw"
rng = random.Random(11)


def detok(t):
    t = t.replace(" @-@ ", "-").replace(" @,@ ", ",").replace(" @.@ ", ".")
    t = re.sub(r" ([,.;:!?%)\]}])", r"\1", t)
    t = re.sub(r"([(\[{$]) ", r"\1", t)
    t = re.sub(r" (n't|'s|'re|'ve|'ll|'d|'m)\b", r"\1", t)
    t = re.sub(r'" ([^"]*?) "', r'"\1"', t)
    return re.sub(r"[ \t]{2,}", " ", t).strip()


def words(t):
    return len(t.split())


def h(s):
    return int(hashlib.sha1(s.encode()).hexdigest()[:8], 16)


def mage(per=120):
    cells = {}
    for r in pq.read_table(f"{SRC}/mage-train-0.parquet").to_pylist():
        if not 60 <= words(r["text"]) <= 600:
            continue
        domain = r["src"].split("_")[0]
        label = 0 if "human" in r["src"] else 1
        cells.setdefault((domain, label), []).append({"text": r["text"], "label": label, "source": "mage", "meta": r["src"]})
    out = []
    for d in {d for d, _ in cells}:
        n = min(per, len(cells.get((d, 0), [])), len(cells.get((d, 1), [])))
        for label in (0, 1):
            out += rng.sample(cells[(d, label)], n)
    return out


def wiki(n=1000):
    paras = [detok(p) for p in pq.read_table(f"{SRC}/wikitext-0.parquet").column("text").to_pylist()]
    paras = [p for p in paras if not p.startswith("=") and 80 <= words(p) <= 300]
    return [{"text": p, "label": 0, "source": "wiki", "meta": "wikitext-103"} for p in rng.sample(paras, n)]


def hc3():
    train, evals = [], []
    for r in pq.read_table(f"{SRC}/hc3-all.parquet").to_pylist():
        q = r["question"]
        for label, answers in ((0, r["human_answers"] or []), (1, r["chatgpt_answers"] or [])):
            if answers and 50 <= words(answers[0]) <= 600:
                row = {"text": detok(answers[0]), "label": label, "source": "hc3", "meta": r["source"]}
                (evals if h(q) % 2 else train).append(row)
    rng.shuffle(train)
    rng.shuffle(evals)
    cap = lambda rows, n: [x for x in rows if x["label"] == 0][:n] + [x for x in rows if x["label"] == 1][:n]
    return cap(train, 500), cap(evals, 500)


def write(name, rows):
    with open(f"{RAW}/{name}.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"  {name}: {len(rows)} (human {sum(r['label'] == 0 for r in rows)})")


if __name__ == "__main__":
    hc3_train, hc3_eval = hc3()
    write("longform-train", mage() + wiki() + hc3_train)
    write("hc3", hc3_eval)
