"""Student essays, human and AI, so school writing (above all by English learners) is not mistaken for AI.

Download first, into .cache/detector/src/ (both CC BY 4.0, Crossley et al.):
    ellipse-train.csv    https://raw.githubusercontent.com/scrosseye/ELLIPSE-Corpus/main/ELLIPSE_Final_github_train.csv
    persuade-train.zip   https://drive.usercontent.google.com/download?id=13phHyDzIsb0MHyJr6q-B-qIa9P2tM135&export=download&confirm=t
                         (a CSV despite the name: PERSUADE 2.0, one row per annotated passage)
AI essays: scripts/detector/data/essays_ai.jsonl, written by Claude Sonnet and Haiku on the same kinds of
prompts, some imitating students and English learners.
Writes .cache/detector/raw/essays-train.jsonl and essays-eval.jsonl, split by text hash.
Usage: python3 scripts/detector/fetch_essays.py
"""
import csv
import hashlib
import json
import random
import re

SRC = ".cache/detector/src"
RAW = ".cache/detector/raw"
rng = random.Random(5)
csv.field_size_limit(10 ** 9)


def words(t):
    return len(t.split())


def is_eval(t):
    return int(hashlib.sha1(t.encode()).hexdigest()[:8], 16) % 4 == 0


def ok(t):
    return 120 <= words(t) <= 700


def ellipse():
    rows = csv.DictReader(open(f"{SRC}/ellipse-train.csv", encoding="utf-8", errors="replace"))
    return [{"text": r["full_text"].strip(), "label": 0, "source": "ellipse", "meta": f"ellipse/grade{r['grade']}/{r['prompt']}"}
            for r in rows if ok(r["full_text"])]


def persuade():
    seen, out = set(), []
    for r in csv.DictReader(open(f"{SRC}/persuade-train.zip", encoding="utf-8", errors="replace")):
        k = r["essay_id_comp"]
        if k in seen or not ok(r["full_text"]):
            continue
        seen.add(k)
        ell = "ell" if r["ell_status"] == "Yes" else "native"
        out.append({"text": r["full_text"].strip(), "label": 0, "source": "persuade", "meta": f"persuade/{ell}/{r['prompt_name']}"})
    return out


def ai():
    out = []
    for line in open("scripts/detector/data/essays_ai.jsonl"):
        d = json.loads(line)
        out.append({"text": d["text"], "label": 1, "source": "claude-essay", "meta": f"{d['model']}/essay/{d['style']}"})
    return out


def excerpt(r):
    """A short one-paragraph opening, cut at a sentence end: timed-test essays look like this. Applied to
    human and AI essays alike, so length and layout can't give the label away."""
    sents = re.split(r"(?<=[.!?])\s+", " ".join(r["text"].split()))
    want, out = rng.randint(80, 160), []
    for x in sents:
        out.append(x)
        if words(" ".join(out)) >= want:
            break
    text = " ".join(out)
    return {**r, "text": text, "meta": r["meta"] + "/excerpt"} if 60 <= words(text) <= 200 else None


def split(rows, n_train, n_eval):
    rng.shuffle(rows)
    return [r for r in rows if not is_eval(r["text"])][:n_train], [r for r in rows if is_eval(r["text"])][:n_eval]


def write(name, rows):
    with open(f"{RAW}/{name}.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"  {name}: {len(rows)} (human {sum(r['label'] == 0 for r in rows)})")


if __name__ == "__main__":
    p = persuade()
    # English learners are the group detectors fail; oversample them among the Persuade essays.
    p_ell = [r for r in p if "/ell/" in r["meta"]]
    p_nat = [r for r in p if "/native/" in r["meta"]]
    e_tr, e_ev = split(ellipse(), 1200, 500)
    pl_tr, pl_ev = split(p_ell, 500, 250)
    pn_tr, pn_ev = split(p_nat, 500, 250)
    a = ai()
    a_tr, a_ev = [r for r in a if not is_eval(r["text"])], [r for r in a if is_eval(r["text"])]
    train = e_tr + pl_tr + pn_tr + a_tr
    write("essays-train", train + [x for x in map(excerpt, train) if x])
    write("essays-eval", e_ev + pl_ev + pn_ev + a_ev)
