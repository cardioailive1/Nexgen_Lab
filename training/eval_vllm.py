#!/usr/bin/env python3
"""Run the held-out eval set through the LIVE vLLM server and write a side-by-side page (reference | served model).

    export NEXGEN_API_KEY=...            # the same key the server was started with (hidden prompt, not in chat)
    python eval_vllm.py                  # all of eval.jsonl (117) -> eval_vllm_results.html / .jsonl
    python eval_vllm.py --n 30           # a domain-spread sample

Uses the exact training prompt and the server's own chat template (thinking is off server-side). The served model
is the bf16 MERGE; training/eval earlier used a 4-bit base, so small differences from eval_results2.html are expected.
Prints sanity counters: errors, empty outputs, reasoning leaks ("Let me analyze"), truncations, mean length ratio.
"""
import argparse, base64, collections, concurrent.futures as cf, html, io, json, os, random, sys, time, urllib.request
from PIL import Image

T = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--data", default=f"{T}/eval.jsonl")
ap.add_argument("--images-root", default=T)
ap.add_argument("--url", default=os.environ.get("VLLM_URL", "http://127.0.0.1:8000"))
ap.add_argument("--model", default="nexgen-pro-v1")
ap.add_argument("--n", type=int, default=0, help="0 = all")
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--max-tokens", type=int, default=500)
ap.add_argument("--workers", type=int, default=6)
ap.add_argument("--max-pixels", type=int, default=1400000)
ap.add_argument("--out", default=f"{T}/eval_vllm_results")
a = ap.parse_args()
key = os.environ.get("NEXGEN_API_KEY")
if not key:
    sys.exit('Set NEXGEN_API_KEY first: read -s -p "key: " NEXGEN_API_KEY; export NEXGEN_API_KEY')

rows = [json.loads(l) for l in open(a.data) if l.strip()]
if a.n and a.n < len(rows):   # domain round-robin, seeded (same idea as eval_generate.py)
    rng = random.Random(a.seed); by = collections.defaultdict(list)
    for r in rows: by[r.get("domain", "?")].append(r)
    for v in by.values(): rng.shuffle(v)
    doms = sorted(by); rng.shuffle(doms); picked = []
    while len(picked) < a.n and any(by.values()):
        for d in doms:
            if by[d] and len(picked) < a.n: picked.append(by[d].pop())
    rows = picked


def load_img(rel):
    img = Image.open(os.path.join(a.images_root, rel)).convert("RGB")
    if img.width * img.height > a.max_pixels:
        s = (a.max_pixels / (img.width * img.height)) ** 0.5
        img = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def run(r):
    t0 = time.time()
    msgs, ref, b64 = [{"role": "system", "content": r["system"]}], "", None
    for m in r["messages"]:
        if m["role"] == "assistant":
            ref = m["content"] if isinstance(m["content"], str) else " ".join(b.get("text", "") for b in m["content"])
            continue
        parts = []
        for b in (m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]):
            if b.get("type") == "image":
                b64 = load_img(b["image"])
                parts.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}})
            else:
                parts.append({"type": "text", "text": b.get("text", "")})
        msgs.append({"role": m["role"], "content": parts})
    body = {"model": a.model, "messages": msgs, "max_tokens": a.max_tokens, "temperature": 0}
    req = urllib.request.Request(a.url.rstrip("/") + "/v1/chat/completions", json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    out = {"domain": r.get("domain"), "reference": ref, "img": b64, "output": "", "finish": "", "error": ""}
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            d = json.load(resp)
        out["output"] = d["choices"][0]["message"]["content"] or ""
        out["finish"] = d["choices"][0].get("finish_reason", "")
    except Exception as e:
        out["error"] = repr(e)[:200]
    out["secs"] = round(time.time() - t0, 1)
    return out


results = []
with cf.ThreadPoolExecutor(a.workers) as ex:
    for i, res in enumerate(ex.map(run, rows), 1):
        results.append(res)
        print(f"[{i}/{len(rows)}] {res['domain']}: {'ERROR ' + res['error'] if res['error'] else str(len(res['output'])) + ' chars, ' + str(res['secs']) + 's'}", flush=True)

with open(a.out + ".jsonl", "w") as f:
    for r in results:
        f.write(json.dumps({k: v for k, v in r.items() if k != "img"}) + "\n")
parts = ["<html><head><meta charset='utf-8'><style>body{font:14px sans-serif;margin:16px}table{border-collapse:collapse}"
         "td,th{border:1px solid #ccc;padding:8px;vertical-align:top;white-space:pre-wrap;max-width:520px}img{max-width:260px}"
         ".d{color:#666;font-size:12px}</style></head><body><h2>NexGen Pro v1 (merged, served by vLLM) - held-out eval</h2>"
         "<table><tr><th>image</th><th>reference</th><th>served model</th></tr>"]
for r in results:
    img = f"<img src='data:image/jpeg;base64,{r['img']}'>" if r["img"] else ""
    out = html.escape(r["output"] or ("ERROR: " + r["error"]))
    parts.append(f"<tr><td>{img}<div class='d'>{html.escape(str(r['domain']))}</div></td><td>{html.escape(r['reference'])}</td><td>{out}</td></tr>")
parts.append("</table></body></html>")
open(a.out + ".html", "w").write("\n".join(parts))

ok = [r for r in results if not r["error"]]
leak = sum(1 for r in ok if "let me analy" in r["output"].lower() or "<think>" in r["output"].lower())
ratios = [len(r["output"]) / max(1, len(r["reference"])) for r in ok]
print("\n== summary ==")
print(f"examples {len(results)}  errors {len(results) - len(ok)}  empty {sum(1 for r in ok if not r['output'].strip())}"
      f"  reasoning-leaks {leak}  truncated(finish=length) {sum(1 for r in ok if r['finish'] == 'length')}")
if ratios:
    print(f"output/reference length ratio: mean {sum(ratios) / len(ratios):.2f}  (1.0 = same length as the reference)")
print("wrote", a.out + ".html", "and", a.out + ".jsonl")
