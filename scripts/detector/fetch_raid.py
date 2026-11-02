"""RAID (Dugan et al. 2024) sample for training and adversarial evaluation.

The datasets-server rows API does not serve RAID, so this reads two parquet shards directly.
Writes .cache/detector/raw/raid-train.jsonl (no attack) and raid-adversarial.jsonl (11 attacks).
Usage: python3 scripts/detector/fetch_raid.py
"""
import json
import os
import random
import urllib.request

import pyarrow.parquet as pq

BASE = "https://huggingface.co/datasets/liamdugan/raid/resolve/refs%2Fconvert%2Fparquet/raid/partial-train/"
CACHE = ".cache/detector/raid"
RAW = ".cache/detector/raw"
SHARDS = ["0000.parquet", "0004.parquet", "0008.parquet"]

os.makedirs(CACHE, exist_ok=True)
rows = []
for shard in SHARDS:
    path = f"{CACHE}/{shard}"
    if not os.path.exists(path):
        print(f"  downloading {shard}")
        urllib.request.urlretrieve(BASE + shard, path)
    t = pq.read_table(path, columns=["model", "attack", "domain", "generation"]).to_pylist()
    rows.extend(t)

rng = random.Random(42)
rng.shuffle(rows)


def ok(text):
    n = len(text.split())
    return 40 <= n <= 900


def take(pred, want_per_label, source):
    kept = {0: [], 1: []}
    seen = set()
    for r in rows:
        if r["model"] == "gpt2" or not pred(r) or not ok(r["generation"]) or r["generation"] in seen:
            continue
        label = 0 if r["model"] == "human" else 1
        if len(kept[label]) >= want_per_label:
            continue
        seen.add(r["generation"])
        kept[label].append({"text": r["generation"], "label": label, "source": source,
                            "meta": f'{r["model"]}/{r["domain"]}/{r["attack"]}'})
    return kept[0] + kept[1]


def write(name, recs):
    with open(f"{RAW}/{name}.jsonl", "w") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
    print(f"  {name}: {len(recs)} rows, human {sum(r['label'] == 0 for r in recs)}")


write("raid-train", take(lambda r: r["attack"] == "none", 450, "raid"))
# Balanced across attacks so no single trick dominates the adversarial numbers.
adv = []
attacks = sorted({r["attack"] for r in rows} - {"none"})
for a in attacks:
    adv.extend(take(lambda r, a=a: r["attack"] == a, 15, "raid-adversarial"))
write("raid-adversarial", adv)
print("  attacks:", ", ".join(attacks))
