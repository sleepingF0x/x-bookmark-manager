"""Embed every bookmark with Workers AI and write data/vectors.bin (int8, row order = data/items.json items).

Document text = title + summary + tags + category + opening of the full text. Cached per id in
data/enrich/embeddings.json so reruns only embed new items.
Usage: CLOUDFLARE_ACCOUNT_ID=<id> python3 -I scripts/embed.py [--model @cf/baai/bge-m3]
"""
import argparse
import json
import os
import subprocess
import urllib.request

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
ACCOUNT = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')  # Workers AI REST calls are per account
CACHE = os.path.join(ROOT, 'data', 'enrich', 'embeddings.json')


def token():
    out = subprocess.run(['npx', 'wrangler', 'auth', 'token'], capture_output=True, text=True, cwd=ROOT).stdout
    return out.strip().splitlines()[-1]


def embed(texts, model, tok):
    req = urllib.request.Request(
        f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/{model}',
        data=json.dumps({'text': texts}).encode(),
        headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    return r['result']['data']


def doc(it):
    return f"{it['title']}\n{it['summary']}\n{' '.join(it['tags'])} {it['category']}\n{it['body'][:400]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='@cf/baai/bge-m3')
    args = ap.parse_args()
    if not ACCOUNT:
        raise SystemExit('Set CLOUDFLARE_ACCOUNT_ID (npx wrangler whoami shows it).')
    items = json.load(open(os.path.join(ROOT, 'data', 'items.json')))['items']
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    cache = cache if cache.get('model') == args.model else {'model': args.model, 'vectors': {}}
    todo = [it for it in items if it['id'] not in cache['vectors']]
    tok = token()
    for i in range(0, len(todo), 50):
        batch = todo[i:i + 50]
        for it, v in zip(batch, embed([doc(it) for it in batch], args.model, tok)):
            cache['vectors'][it['id']] = v
        print(f'embedded {min(i + 50, len(todo))}/{len(todo)}')
    json.dump(cache, open(CACHE, 'w'))

    # int8 quantization of L2-normalised vectors: 1 byte/dim, cosine stays accurate to ~1e-2.
    import math
    rows = bytearray()
    for it in items:
        v = cache['vectors'][it['id']]
        n = math.sqrt(sum(x * x for x in v)) or 1
        rows += bytes((max(-127, min(127, round(x / n * 127))) & 0xFF) for x in v)
    open(os.path.join(ROOT, 'data', 'vectors.bin'), 'wb').write(rows)
    print(f'data/vectors.bin: {len(items)} x {len(rows) // len(items)} int8 ({len(rows) / 1e6:.2f} MB), model {args.model}')


if __name__ == '__main__':
    main()
