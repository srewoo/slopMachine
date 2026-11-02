"""Modern AI text and licensed human counterparts, from dumps in .cache/detector/src (see README).

AI:     LMArena arena-human-preference-140k (CC BY 4.0): 2025 responses from GPT, Gemini, Claude, Grok,
        DeepSeek, Llama, Qwen, Mistral and others. WildChat-1M (ODC-BY): GPT-4 and GPT-3.5 responses.
        Includes real "make it sound human" requests, the evasion people actually try.
Human:  ELL Stack Exchange questions (CC BY-SA 4.0), written by English learners: non-native writing.
        Unix & Linux Stack Exchange answers (CC BY-SA 4.0): technical prose, the closest human match to docs.
        Both before 2022, so no AI text.

Download first, into .cache/detector/src/:
    arena-0..6.parquet   https://huggingface.co/datasets/lmarena-ai/arena-human-preference-140k/resolve/refs%2Fconvert%2Fparquet/default/train/000N.parquet
    wildchat-0..1.parquet https://huggingface.co/datasets/allenai/WildChat-1M/resolve/refs%2Fconvert%2Fparquet/default/train/000N.parquet
    ell.7z               https://archive.org/download/stackexchange/ell.stackexchange.com.7z
    unix.7z              https://archive.org/download/stackexchange/unix.stackexchange.com.7z

Writes .cache/detector/raw/{modern-train,modern-eval,ell-train,ell-eval,unix-train,unix-eval}.jsonl.
Splits are by conversation or post hash, so no prompt lands in both. Usage (pyarrow needed):
    python3 scripts/detector/fetch_modern.py
"""
import glob
import hashlib
import html
import json
import os
import random
import re
import subprocess
import xml.etree.ElementTree as ET

import pyarrow.parquet as pq

SRC = ".cache/detector/src"
RAW = ".cache/detector/raw"
CUTOFF = "2022-06-01"  # before public chat models
rng = random.Random(7)

GENRES = [
    ("humanize", r"sound (more )?(human|natural)|humani[sz]e|human-?like|undetectable|bypass|ai detect|not sound like (an )?ai|less robotic|like a (real )?person wrote"),
    ("email", r"\be-?mail\b|\breply to\b|\bwrite a (letter|message) to\b|\bcover letter\b"),
    ("post", r"linkedin|tweet|\bpost\b|\bblog\b|caption|social media|reddit|facebook|instagram"),
    ("marketing", r"product description|ad copy|\bads?\b|marketing|landing page|slogan|sales pitch|newsletter|promot"),
    ("docs", r"documentation|readme|\bhow (do|to|can)\b|tutorial|\bguide\b|instructions|explain|step[- ]by[- ]step|troubleshoot"),
    ("essay", r"\bessay\b|\bparagraph\b|\bwrite (about|an article)|\barticle\b|\bstory\b|opinion"),
]


def genre_of(prompt):
    p = prompt.lower()
    for name, pat in GENRES:
        if re.search(pat, p):
            return name
    return "other"


def vendor_of(model):
    m = model.lower()
    for v, pat in [("openai", r"gpt|^o\d|chatgpt"), ("google", r"gemini|gemma"), ("anthropic", r"claude"), ("xai", r"grok"),
                   ("deepseek", r"deepseek"), ("meta", r"llama"), ("qwen", r"qwen|qwq"), ("mistral", r"mistral|mixtral|magistral")]:
        if re.search(pat, m):
            return v
    return "other"


def plain(md):
    """Markdown as it reads once pasted into an email or post: markers gone, words kept."""
    t = re.sub(r"```.*?```", "", md, flags=re.S)
    t = re.sub(r"^\s*#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"\*\*|__|(?<!\w)\*(?!\s)|`", "", t)
    t = re.sub(r"^\s*[-*•]\s+", "- ", t, flags=re.M)
    t = re.sub(r"^\s*---+\s*$", "", t, flags=re.M)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def words(t):
    return len(t.split())


def h(s):
    return int(hashlib.sha1(s.encode()).hexdigest()[:8], 16)


def is_eval(key):
    return h(key) % 5 == 0


def text_of(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return c
    return "\n".join(p.get("text") or "" for p in (c or []) if isinstance(p, dict))


def arena():
    out = []
    for f in sorted(glob.glob(f"{SRC}/arena-*.parquet")):
        for r in pq.read_table(f, columns=["id", "model_a", "model_b", "conversation_a", "conversation_b", "language", "is_code"]).to_pylist():
            if r["language"] != "en" or str(r["is_code"]) == "True":
                continue
            for side in "ab":
                conv = r[f"conversation_{side}"]
                if not conv or len(conv) != 2:
                    continue  # single-turn only: the reply answers exactly one request
                prompt, reply = text_of(conv[0]), plain(text_of(conv[1]))
                if not (60 <= words(reply) <= 700) or "|" in reply[:400]:
                    continue
                model = r[f"model_{side}"]
                out.append({"text": reply, "label": 1, "key": r["id"], "meta": f"{vendor_of(model)}/{genre_of(prompt)}/{model}", "source": "arena"})
    return out


def wildchat():
    out = []
    for f in sorted(glob.glob(f"{SRC}/wildchat-*.parquet")):
        for r in pq.read_table(f, columns=["conversation_hash", "model", "conversation", "language"]).to_pylist():
            conv = r["conversation"]
            if r["language"] != "English" or not conv or len(conv) != 2 or "gpt-4" not in r["model"]:
                continue
            reply = plain(conv[1].get("content") or "")
            if 60 <= words(reply) <= 700:
                out.append({"text": reply, "label": 1, "key": r["conversation_hash"], "meta": f"openai/{genre_of(conv[0].get('content') or '')}/{r['model']}", "source": "wildchat"})
    return out


def stackexchange(archive, post_type, source, max_rows):
    """Question (1) or answer (2) bodies before the cutoff, quoted examples and code removed."""
    path = f"{SRC}/{source}-Posts.xml"
    if not os.path.exists(path):
        subprocess.run(["bsdtar", "-xf", f"{SRC}/{archive}", "-C", SRC, "Posts.xml"], check=True)
        os.rename(f"{SRC}/Posts.xml", path)
    out = []
    for _, el in ET.iterparse(path):
        if el.tag != "row":
            continue
        a = el.attrib
        if a.get("PostTypeId") == str(post_type) and a.get("CreationDate", "9") < CUTOFF and int(a.get("Score", "0")) >= 0:
            body = re.sub(r"<(pre|blockquote)[^>]*>.*?</\1>", " ", a.get("Body", ""), flags=re.S)  # inline <code> text stays: AI replies keep theirs too
            body = re.sub(r"</p>|<br ?/?>|</li>", "\n", body)
            text = re.sub(r"\n\s*\n+", "\n\n", html.unescape(re.sub(r"<[^>]+>", "", body))).strip()
            if 50 <= words(text) <= 400 and not re.search(r"https?://", text[:80]):
                out.append({"text": text, "label": 0, "key": a["Id"], "meta": f"{source}/{a['CreationDate'][:4]}", "source": source})
        el.clear()
    rng.shuffle(out)
    return out[:max_rows]


def capped(rows, per, keyf):
    """At most `per` rows per bucket, so no vendor or genre dominates."""
    rng.shuffle(rows)
    seen, out = {}, []
    for r in rows:
        k = keyf(r)
        if seen.get(k, 0) < per:
            seen[k] = seen.get(k, 0) + 1
            out.append(r)
    return out


def write(name, rows):
    with open(f"{RAW}/{name}.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps({k: v for k, v in r.items() if k != "key"}) + "\n")
    print(f"  {name}: {len(rows)}")


if __name__ == "__main__":
    ai = arena() + wildchat()
    ai = list({r["text"]: r for r in ai}.values())
    bucket = lambda r: "/".join(r["meta"].split("/")[:2])  # vendor/genre
    tr = capped([r for r in ai if not is_eval(r["key"])], 60, bucket)
    ev = capped([r for r in ai if is_eval(r["key"])], 25, bucket)
    write("modern-train", tr)
    write("modern-eval", ev)
    for archive, kind, src, n in [("ell.7z", 1, "ell", 8000), ("unix.7z", 2, "unix", 8000)]:
        rows = stackexchange(archive, kind, src, n)
        write(f"{src}-train", [r for r in rows if not is_eval(r["key"] + src)][:2000])
        write(f"{src}-eval", [r for r in rows if is_eval(r["key"] + src)][:1000])
