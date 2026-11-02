"""Fine-tunes a compact detector on the training corpora and exports it for the extension.

Base: intfloat/e5-small-v2 (MIT, 33M parameters). Trains on split A (70% of training rows, by text
hash, written by prepare_ft.ts); split B is left for the ensemble in train.ts, so the ensemble never
sees this model's scores on texts it memorized. Exports int8 ONNX + tokenizer to
static/models/slop-detector/ for Transformers.js. Usage (torch, transformers, onnx, onnxruntime):
    node scripts/detector/prepare_ft.ts && python3 scripts/detector/finetune.py
"""
import json
import os
import random
import shutil

import numpy as np
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForSequenceClassification, AutoTokenizer

BASE = "intfloat/e5-small-v2"
OUT = "static/models/slop-detector"
MAX_LEN = 256


def load():
    """Split A, already normalized by prepare_ft.ts exactly as the extension normalizes at run time."""
    return [(r["text"], r["label"], r["source"]) for r in map(json.loads, open(".cache/detector/ft-train.jsonl"))]


def main():
    random.seed(0)
    torch.manual_seed(0)
    rows = load()
    # Every writing family weighs the same, split evenly between its human and AI text.
    groups = {}
    for _, y, s in rows:
        groups[(s, y)] = groups.get((s, y), 0) + 1
    families = {s for s, _ in groups}
    labels = {f: sum(1 for (s, _) in groups if s == f) for f in families}
    weights = [len(rows) / (len(families) * labels[s] * groups[(s, y)]) for _, y, s in rows]
    print(f"  {len(rows)} texts: " + ", ".join(f"{s}/{'AI' if y else 'human'} {n}" for (s, y), n in sorted(groups.items())))

    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(BASE)
    model = AutoModelForSequenceClassification.from_pretrained(BASE, num_labels=2).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=4e-5, weight_decay=0.01)
    epochs, batch = 3, 32
    steps = epochs * ((len(rows) + batch - 1) // batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=4e-5, total_steps=steps, pct_start=0.1)
    order = list(range(len(rows)))
    model.train()
    step = 0
    for ep in range(epochs):
        random.shuffle(order)
        total = 0.0
        for b in range(0, len(order), batch):
            idx = order[b:b + batch]
            enc = tok([rows[i][0] for i in idx], truncation=True, max_length=MAX_LEN, padding="max_length", return_tensors="pt").to(dev)  # static shapes: the Apple GPU recompiles for every new length
            y = torch.tensor([rows[i][1] for i in idx], device=dev)
            w = torch.tensor([weights[i] for i in idx], device=dev, dtype=torch.float32)
            loss = (torch.nn.functional.cross_entropy(model(**enc).logits, y, reduction="none") * w).mean()
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            total += loss.item()
            step += 1
            if step % 10 == 0:
                print(f"  epoch {ep + 1} step {step}/{steps} loss {total / (b // batch + 1):.4f}", flush=True)

    model.eval().to("cpu")
    model.config.id2label = {0: "human", 1: "ai"}
    model.config.label2id = {"human": 0, "ai": 1}
    # Full-precision weights stay in the cache, so a re-export never needs retraining.
    model.save_pretrained(".cache/detector/slop-detector-fp32")
    tok.save_pretrained(".cache/detector/slop-detector-fp32")
    export(model, tok, rows)


def export(model, tok, rows):
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(f"{OUT}/onnx")
    model.config.save_pretrained(OUT)
    tok.save_pretrained(OUT)
    dummy = tok(["export sample"], return_tensors="pt")
    # Positional order must match forward(input_ids, attention_mask, token_type_ids), not the tokenizer's dict order.
    names = [n for n in ("input_ids", "attention_mask", "token_type_ids") if n in dummy]
    fp32 = f"{OUT}/onnx/model.onnx"
    torch.onnx.export(model, tuple(dummy[n] for n in names), fp32, input_names=names, output_names=["logits"],
                      dynamic_axes={**{n: {0: "batch", 1: "seq"} for n in names}, "logits": {0: "batch"}}, opset_version=14)
    quantize_dynamic(fp32, f"{OUT}/onnx/model_quantized.onnx", weight_type=QuantType.QInt8)
    os.remove(fp32)

    # The exported int8 model must agree with the trained one.
    sess = ort.InferenceSession(f"{OUT}/onnx/model_quantized.onnx")
    sample = [rows[i][0] for i in range(0, len(rows), max(1, len(rows) // 20))][:20]
    enc = tok(sample, truncation=True, max_length=MAX_LEN, padding=True, return_tensors="np")
    onnx_logits = sess.run(None, {n: enc[n] for n in names})[0]
    with torch.no_grad():
        torch_logits = model(**{k: torch.tensor(v) for k, v in enc.items()}).logits.numpy()
    d = (onnx_logits[:, 1] - onnx_logits[:, 0]) - (torch_logits[:, 1] - torch_logits[:, 0])
    print(f"  int8 vs fp32 logit drift: max {np.abs(d).max():.3f}, mean {np.abs(d).mean():.3f}")
    # int8 rounding moves logits a little; a wiring bug (swapped inputs) moves them by several units.
    if np.abs(d).mean() > 0.5:
        shutil.rmtree(OUT, ignore_errors=True)
        raise SystemExit("Exported model disagrees with the trained one; removed it.")
    print(f"  wrote {OUT} ({sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs) / 1e6:.1f} MB)")


if __name__ == "__main__":
    import sys
    if "--export-only" in sys.argv:  # re-export the cached fp32 weights without retraining
        export(AutoModelForSequenceClassification.from_pretrained(".cache/detector/slop-detector-fp32").eval(),
               AutoTokenizer.from_pretrained(".cache/detector/slop-detector-fp32"), load())
    else:
        main()
