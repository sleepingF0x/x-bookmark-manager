"""Merge tweets + enrichment + labels into data/items.json (seeded into D1 by scripts/seed_d1.py).

Usage: python3 -I scripts/build_site.py
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import digest  # noqa: E402

ROOT = digest.ROOT
OUT = os.path.join(ROOT, 'data', 'items.json')


def tag_canonicalizer(labels):
    """Map spelling variants (case, spaces, hyphens, trailing plural s) to the most common spelling."""
    from collections import Counter
    counts = Counter(t for lab in labels.values() for t in lab['tags'])
    key = lambda t: t.lower().replace(' ', '').replace('-', '')
    keys = {key(t) for t in counts}
    group = lambda t: key(t)[:-1] if key(t).endswith('s') and key(t)[:-1] in keys else key(t)
    best = {}
    for t, n in counts.most_common():
        best.setdefault(group(t), t)
    return lambda t: best[group(t)]


def media_list(r):
    kind = {'photo': 'photo', 'video': 'video', 'animated_gif': 'gif'}
    return [{'t': kind.get(m['type'], 'photo'), 'u': m['url'], **({'v': m['video']} if m.get('video') else {})} for m in r['media']]


def quote_of(r, det):
    q = r.get('quoted')
    if not q:
        return None
    doc = (det.get(q['id']) or {}).get('doc')
    return {'id': q['id'], 'url': q['url'], 'handle': q['author']['handle'], 'name': q['author']['name'],
            'body': q['text'], 'media': media_list(q), 'articleTitle': doc['title'] if doc else None}


def link_cards(links, gh):
    """GitHub repos with their metadata, plus other outbound links (X permalinks/articles are rendered inline)."""
    repos, other = [], []
    for u in dict.fromkeys(links):
        m = digest.REPO_RE.search(u)
        info = m and gh.get(f"{m.group(1)}/{m.group(2).removesuffix('.git')}".lower())
        if info and not info.get('missing'):
            repos.append({'name': info['name'], 'stars': info['stars'], 'desc': info.get('description') or '', 'url': u})
        elif not re.match(r'https?://(www\.)?(x|twitter)\.com/', u):
            other.append(u)
    return {'repos': repos, 'links': other}


def main():
    tweets, gh, ocr, det = digest.load_sources()
    labels = json.load(open(os.path.join(ROOT, 'data', 'enrich', 'labels.json')))
    canon = tag_canonicalizer(labels)
    items, unlabeled = [], 0
    for r in tweets:
        if r.get('unavailable'):
            continue
        lab = labels.get(r['id'])
        if not lab:
            unlabeled += 1
            continue
        published = datetime.strptime(r['created_at'], '%a %b %d %H:%M:%S %z %Y')
        cleanup, reason = lab['cleanup'], lab['cleanup_reason']
        # The model sometimes ignores the 30-day rule; news this fresh is still current.
        if cleanup == 'expired' and lab['type'] == '资讯' and datetime.now(published.tzinfo) - published < timedelta(days=30):
            cleanup, reason = 'keep', ''
        photo = next((m['url'] for m in r['media'] if m['type'] == 'photo'), None)
        if not photo and r['media']:
            photo = r['media'][0]['url']  # video poster
        d = det.get(r['id']) or {}
        items.append({
            'id': r['id'],
            'url': r['url'],
            'rank': r['bookmark_rank'],
            'handle': r['author']['handle'],
            'name': r['author']['name'],
            'date': published.strftime('%Y-%m-%d'),
            'category': lab['category'],
            'tags': list(dict.fromkeys(canon(t) for t in lab['tags'])),
            'type': lab['type'],
            'title': lab['title'],
            'summary': lab['summary'],
            'score': lab['score'],
            'cleanup': cleanup,
            'reason': reason,
            'thumb': photo,
            'video': any(m['type'] != 'photo' for m in r['media']),
            # Structured post for the reader; image OCR is used for labelling only, never shown.
            'body': r['text'],
            'media': media_list(r),
            'quote': quote_of(r, det),
            'article': d.get('doc'),
            'thread': d.get('thread') or [],
            **link_cards(r['links'], gh),
        })
    json.dump({'generated': datetime.now().strftime('%Y-%m-%d'), 'items': items},
              open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'data/items.json: {len(items)} items, {os.path.getsize(OUT) / 1e6:.1f} MB, {unlabeled} unlabeled skipped')


if __name__ == '__main__':
    main()
