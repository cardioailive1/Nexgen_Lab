"""Hold out a small, domain-stratified eval split from train.jsonl.

  python split_eval.py --data train.jsonl --eval-n 120

Writes train_split.jsonl (the rest) and eval.jsonl (held-out). Train on
train_split.jsonl, pass --eval-data eval.jsonl. Deterministic (seeded).
"""
import argparse, collections, json, random


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="train.jsonl")
    ap.add_argument("--eval-n", type=int, default=120)
    ap.add_argument("--min-per-domain", type=int, default=2)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out-train", default="train_split.jsonl")
    ap.add_argument("--out-eval", default="eval.jsonl")
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(a.data) if l.strip()]
    by = collections.defaultdict(list)
    for r in rows:
        by[r.get("domain", "?")].append(r)
    rng = random.Random(a.seed)
    frac = a.eval_n / max(1, len(rows))
    held = set()
    for d, rs in sorted(by.items()):
        rng.shuffle(rs)
        k = max(a.min_per_domain, round(len(rs) * frac))
        k = min(k, max(0, len(rs) - 1))  # never take a whole domain
        held.update(id(r) for r in rs[:k])
    ev = [r for r in rows if id(r) in held]
    tr = [r for r in rows if id(r) not in held]
    with open(a.out_train, "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in tr)
    with open(a.out_eval, "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in ev)
    print(f"{len(tr)} train -> {a.out_train}, {len(ev)} eval -> {a.out_eval} ({len(by)} domains)")


if __name__ == "__main__":
    main()
