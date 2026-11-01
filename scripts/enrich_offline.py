"""Enrichment that needs no X session: GitHub repo metadata (via gh) and image OCR (macOS Vision).

Writes data/enrich/github.json and data/enrich/ocr.json; reruns skip what is already done.
Usage: python3 -I scripts/enrich_offline.py [github|ocr]...
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
ENRICH = os.path.join(ROOT, 'data', 'enrich')
IMG_DIR = os.path.join(ROOT, 'data', 'images')
REPO_RE = re.compile(r'github\.com/([\w.-]+)/([\w.-]+)')


def load(name, default):
    p = os.path.join(ENRICH, name)
    return json.load(open(p)) if os.path.exists(p) else default


def save(name, obj):
    json.dump(obj, open(os.path.join(ENRICH, name), 'w'), ensure_ascii=False, indent=1)


def all_records():
    for r in json.load(open(os.path.join(ROOT, 'data', 'tweets.json'))):
        if r.get('unavailable'):
            continue
        yield r
        if r.get('quoted'):
            yield r['quoted']


def github():
    repos = load('github.json', {})
    wanted = set()
    for r in all_records():
        for u in r['links']:
            m = REPO_RE.search(u)
            if m and m.group(1) not in ('orgs', 'sponsors', 'features', 'topics', 'settings'):
                wanted.add(f"{m.group(1)}/{m.group(2).removesuffix('.git')}".lower())
    todo = sorted(wanted - set(repos))
    print(f'github: {len(wanted)} repos, {len(todo)} to fetch')

    def fetch(full):
        p = subprocess.run(['gh', 'api', f'repos/{full}', '--jq',
                            '{name: .full_name, description, stars: .stargazers_count, language, '
                            'topics, pushed_at, archived, homepage}'],
                           capture_output=True, text=True)
        return full, json.loads(p.stdout) if p.returncode == 0 else {'missing': True}

    with ThreadPoolExecutor(8) as ex:
        for full, info in ex.map(fetch, todo):
            repos[full] = info
    save('github.json', repos)
    print(f"github: done, {sum(1 for v in repos.values() if v.get('missing'))} missing/renamed")


def ocr():
    os.makedirs(IMG_DIR, exist_ok=True)
    results = load('ocr.json', {})
    jobs = []  # (media_url, local_path)
    for r in all_records():
        for m in r['media']:
            if m['type'] == 'photo' and m['url'] not in results:
                jobs.append((m['url'], os.path.join(IMG_DIR, os.path.basename(m['url']))))
    print(f'ocr: {len(jobs)} images to process')

    def download(job):
        url, path = job
        if os.path.exists(path):
            return job
        # Some media hosts reject the size suffix; fall back to the bare URL, then give up on that image.
        for candidate in (url + '?name=large', url):
            try:
                urllib.request.urlretrieve(candidate, path)
                return job
            except Exception:
                continue
        print(f'ocr: download failed {url}')
        return None

    with ThreadPoolExecutor(8) as ex:
        jobs = [j for j in ex.map(download, jobs) if j]
    swift = os.path.join(ROOT, 'scripts', 'ocr.swift')
    by_path = {p: u for u, p in jobs}
    paths = list(by_path)
    for i in range(0, len(paths), 40):
        batch = paths[i:i + 40]
        out = subprocess.run(['swift', swift, *batch], capture_output=True, text=True, check=True).stdout
        for p, text in json.loads(out).items():
            results[by_path[p]] = text
        save('ocr.json', results)
        print(f'ocr: {min(i + 40, len(paths))}/{len(paths)}')


if __name__ == '__main__':
    os.makedirs(ENRICH, exist_ok=True)
    for step in sys.argv[1:] or ['github', 'ocr']:
        {'github': github, 'ocr': ocr}[step]()
