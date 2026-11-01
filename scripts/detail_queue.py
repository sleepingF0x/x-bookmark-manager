"""Build data/detail-queue.json: bookmarks whose full content needs a post page visit (capture-details.mjs).

Two kinds: X Article posts (the bookmark list only carries a preview) and likely thread heads
(top-level posts with thread markers such as 🧵, "1/", "thread"), whose continuation lives in replies.
Usage: python3 -I scripts/detail_queue.py data/raw/<export run>
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
THREAD = re.compile(r'🧵|👇|⬇️|\b1/\d*|（1/|\(1/|^1[\.、/]|一条线程|thread', re.I | re.M)


def article_owners(run_dir):
    """id -> handle of every post in the export that carries an X Article."""
    owners = {}

    def find(o, owner=None):
        if isinstance(o, dict):
            if o.get('__typename') == 'Tweet':
                u = o.get('core', {}).get('user_results', {}).get('result', {})
                owner = (o.get('rest_id'), (u.get('core') or u.get('legacy', {})).get('screen_name'))
            if isinstance(o.get('article'), dict) and owner:
                owners[owner[0]] = owner[1]
            for v in o.values():
                find(v, owner)
        elif isinstance(o, list):
            for v in o:
                find(v, owner)

    for f in sorted(glob.glob(os.path.join(run_dir, '*-Bookmarks-*.json'))):
        find(json.load(open(f)))
    return owners


def main(run_dir):
    arts = [{'id': k, 'handle': v} for k, v in article_owners(run_dir).items()]
    tweets = [r for r in json.load(open(os.path.join(ROOT, 'data', 'tweets.json'))) if not r.get('unavailable')]
    seen = {a['id'] for a in arts}
    heads = [{'id': r['id'], 'handle': r['author']['handle']} for r in tweets
             if r['in_reply_to'] is None and THREAD.search(r['text']) and r['id'] not in seen]
    json.dump(arts + heads, open(os.path.join(ROOT, 'data', 'detail-queue.json'), 'w'))
    print(f'data/detail-queue.json: {len(arts)} articles + {len(heads)} thread-head candidates')


if __name__ == '__main__':
    main(sys.argv[1])
