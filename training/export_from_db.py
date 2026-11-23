#!/usr/bin/env python3
"""Export the Lab's captioned vision data straight from Postgres + S3.

Use this when the Lab web app is down or its export button fails. It produces
exactly what the Lab export produces: train.jsonl + images/ in the current folder
(the format train_vision_lora.py expects).

Needs (environment variables; do not paste them into chats or commit them):
  DATABASE_URL         Postgres EXTERNAL connection URL of the database that holds
                       the Lab data (Render: database page -> Connect -> External)
  S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
  S3_REGION (default "auto"), S3_ENDPOINT (only for R2/other S3-compatible stores)

    pip install psycopg2-binary boto3 pillow
    python export_from_db.py --out . [--domains a,b] [--limit 50]
"""
import argparse, json, os, sys
from concurrent.futures import ThreadPoolExecutor

QUERY = """
SELECT id, domain, storage_key, persistent, original_name, caption
FROM vision_records
WHERE caption_status IN ('captioned', 'manual')
  AND caption IS NOT NULL AND caption <> ''
  {domain_clause}
ORDER BY created_at
{limit_clause}
"""


def load_rows(database_url, domains, limit):
    import psycopg2
    conn = psycopg2.connect(database_url, sslmode=os.environ.get("PGSSLMODE", "require"))
    try:
        cur = conn.cursor()
        params = []
        domain_clause = ""
        if domains:
            domain_clause = "AND domain = ANY(%s)"
            params.append(domains)
        limit_clause = f"LIMIT {int(limit)}" if limit else ""
        cur.execute(QUERY.format(domain_clause=domain_clause, limit_clause=limit_clause), params)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        conn.close()


def make_s3():
    import boto3
    kw = dict(
        region_name=os.environ.get("S3_REGION", "auto"),
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
    )
    if os.environ.get("S3_ENDPOINT"):
        kw["endpoint_url"] = os.environ["S3_ENDPOINT"]
    return boto3.client("s3", **kw)


def record_line(row, image_name):
    return json.dumps({
        "domain": row["domain"],
        "system": f"You are an expert assistant specializing in the {row['domain']} domain.",
        "messages": [
            {"role": "user", "content": [
                {"type": "image", "image": f"images/{image_name}"},
                {"type": "text", "text": "Describe what is shown in this image."},
            ]},
            {"role": "assistant", "content": row["caption"]},
        ],
    })


def main(argv=None, rows=None, s3=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=".")
    ap.add_argument("--domains", default="", help="comma-separated; default all")
    ap.add_argument("--limit", type=int, default=0, help="only the first N records (smoke test)")
    ap.add_argument("--workers", type=int, default=16)
    a = ap.parse_args(argv)
    os.makedirs(os.path.join(a.out, "images"), exist_ok=True)

    domains = [d.strip() for d in a.domains.split(",") if d.strip()]
    if rows is None:
        rows = load_rows(os.environ["DATABASE_URL"], domains, a.limit)
    print(f"{len(rows)} captioned records found in the database")
    if not rows:
        sys.exit("Nothing to export. Wrong database? Check the table vision_records.")
    if s3 is None:
        s3 = make_s3()
    bucket = os.environ.get("S3_BUCKET", "")

    def fetch(row):
        ext = os.path.splitext(row["original_name"] or "")[1] or ".jpg"
        name = f"{row['id']}{ext}"
        dest = os.path.join(a.out, "images", name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            return row, name, None
        if not row["persistent"]:
            return row, name, "image was on the Lab's local disk, not S3 (lost on redeploy)"
        try:
            body = s3.get_object(Bucket=bucket, Key=row["storage_key"])["Body"].read()
            with open(dest, "wb") as f:
                f.write(body)
            return row, name, None
        except Exception as e:  # noqa
            return row, name, f"{e.__class__.__name__}: {str(e)[:120]}"

    ok, bad = [], []
    with ThreadPoolExecutor(a.workers) as ex:
        for i, (row, name, err) in enumerate(ex.map(fetch, rows), 1):
            (bad if err else ok).append((row, name, err))
            if i % 500 == 0:
                print(f"  {i}/{len(rows)}  ok={len(ok)} missing={len(bad)}")
    with open(os.path.join(a.out, "train.jsonl"), "w") as f:
        f.write("\n".join(record_line(r, n) for r, n, _ in ok))
    print(f"wrote {len(ok)} records to {a.out}/train.jsonl and images/  ({len(bad)} skipped)")
    for r, n, e in bad[:5]:
        print(f"  skipped {r['id']}: {e}")
    if bad and not ok:
        sys.exit("No images could be read. Check the S3 settings, or the images are gone.")


if __name__ == "__main__":
    main()
