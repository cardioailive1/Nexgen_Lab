#!/usr/bin/env python3
"""Send one image to the deployed endpoint and print the reply.

    python test_endpoint.py <endpoint-url> <image.jpg> [domain]

Prompts (hidden) for an HF token with access to the endpoint, so nothing is
stored in shell history. Uses the exact prompt format the model was trained on.
"""
import base64, getpass, json, sys, urllib.request

url, path = sys.argv[1].rstrip("/"), sys.argv[2]
domain = sys.argv[3] if len(sys.argv) > 3 else "general"
token = getpass.getpass("HF token for the endpoint: ")
b64 = base64.b64encode(open(path, "rb").read()).decode()
body = {
    "system": f"You are an expert assistant specializing in the {domain} domain.",
    "messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
        {"type": "text", "text": "Describe what is shown in this image."}]}],
    "max_tokens": 500,
}
req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
    "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=600) as r:
    res = json.load(r)
print(res["content"][0]["text"] if "content" in res else json.dumps(res, indent=2))
print("\nusage:", res.get("usage"))
