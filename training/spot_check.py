#!/usr/bin/env python3
"""Spot-check a Lab vision export before training.

Run where dataset.zip is unzipped (train.jsonl + images/):
    python spot_check.py --data train.jsonl --per-domain 5 --min-per-domain 3

Writes:
  spot_check.html  image + caption cards, grouped by domain, to eyeball
  spot_check.csv   same sample with an empty `verdict` column to fill in
and prints automatic flags over the WHOLE dataset: missing/unreadable images,
empty or very short/long captions, duplicate captions, duplicate images,
captions that look like refusals or placeholders, tiny images.
Small domains are sampled at least --min-per-domain times (or fully).
"""
import argparse, base64, collections, csv, hashlib, html, io, json, os, random
from PIL import Image

BAD_PHRASES = ("as an ai", "i cannot", "i can't", "i'm sorry", "unable to", "lorem ipsum",
               "todo", "tbd", "placeholder", "image of an image")


def caption_of(rec):
    for m in reversed(rec["messages"]):
        if m["role"] == "assistant":
            c = m["content"]
            return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c)
    return ""


def image_of(rec):
    for m in rec["messages"]:
        if isinstance(m["content"], list):
            for b in m["content"]:
                if b.get("type") == "image":
                    return b["image"]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="train.jsonl")
    ap.add_argument("--images-root", default=".")
    ap.add_argument("--per-domain", type=int, default=5)
    ap.add_argument("--min-per-domain", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="spot_check")
    a = ap.parse_args()
    recs = [json.loads(l) for l in open(a.data) if l.strip()]
    flags = collections.defaultdict(list)
    cap_seen, img_seen = {}, {}
    for i, r in enumerate(recs):
        cap, path = caption_of(r).strip(), image_of(r)
        full = os.path.join(a.images_root, path) if path else None
        if not full or not os.path.exists(full):
            flags["missing_image"].append(i); continue
        try:
            with Image.open(full) as im:
                if min(im.size) < 64: flags["tiny_image"].append(i)
        except Exception:
            flags["unreadable_image"].append(i)
        h = hashlib.md5(open(full, "rb").read()).hexdigest()
        if h in img_seen: flags["duplicate_image"].append(i)
        img_seen.setdefault(h, i)
        if not cap: flags["empty_caption"].append(i)
        elif len(cap) < 40: flags["short_caption(<40 chars)"].append(i)
        elif len(cap) > 3000: flags["long_caption(>3000 chars)"].append(i)
        if cap.lower() in cap_seen: flags["duplicate_caption"].append(i)
        cap_seen.setdefault(cap.lower(), i)
        if any(p in cap.lower() for p in BAD_PHRASES): flags["suspicious_phrase"].append(i)

    by_dom = collections.defaultdict(list)
    for i, r in enumerate(recs):
        by_dom[r.get("domain", "unknown")].append(i)
    rnd = random.Random(a.seed)
    sample = []
    for d, idx in sorted(by_dom.items()):
        k = min(len(idx), max(a.per_domain, a.min_per_domain))
        sample += [(d, i) for i in rnd.sample(idx, k)]

    cards, rows = [], []
    for d, i in sample:
        r = recs[i]; path = image_of(r); cap = caption_of(r)
        try:
            im = Image.open(os.path.join(a.images_root, path)).convert("RGB")
            im.thumbnail((360, 360)); b = io.BytesIO(); im.save(b, "JPEG", quality=80)
            src = "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()
        except Exception:
            src = ""
        cards.append(f'<div class="c"><div class="d">{html.escape(d)} · #{i}</div>'
                     f'<img src="{src}"><p>{html.escape(cap)}</p></div>')
        rows.append([d, i, path, cap, ""])
    open(a.out + ".html", "w").write(
        "<meta charset=utf-8><style>body{font:14px system-ui;margin:16px}.c{display:inline-block;"
        "vertical-align:top;width:380px;margin:8px;padding:10px;border:1px solid #ccc;border-radius:8px}"
        ".d{font-weight:600;margin-bottom:6px}img{max-width:100%}</style><h2>Spot check</h2>" + "".join(cards))
    with open(a.out + ".csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["domain", "record_index", "image", "caption", "verdict"]); w.writerows(rows)

    print(f"records: {len(recs)}  domains: {len(by_dom)}  sampled: {len(sample)}")
    for d, idx in sorted(by_dom.items(), key=lambda x: len(x[1])):
        print(f"  {d:32s} {len(idx):5d}" + ("   <-- small" if len(idx) < 100 else ""))
    print("automatic flags (whole dataset):" if flags else "automatic flags: none")
    for k, v in flags.items():
        print(f"  {k}: {len(v)}  e.g. records {v[:5]}")
    print(f"wrote {a.out}.html and {a.out}.csv")


if __name__ == "__main__":
    main()
