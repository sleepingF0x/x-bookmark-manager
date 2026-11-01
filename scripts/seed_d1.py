"""Write data/seed.sql: the locally built library (data/items.json + data/vectors.bin) as D1 rows.

bookmarked = still in the given export run and not removed afterwards per data/unbookmark-log.json.
Accession numbers follow the export order (rank 0 = newest), so the oldest bookmark is No. 1.
--update-data writes UPDATEs of the item JSON only (keeps X status, bin and vectors) for re-shaping existing rows.
Usage: python3 -I scripts/seed_d1.py data/raw/<latest export run>
       python3 -I scripts/seed_d1.py --update-data
       npx wrangler d1 execute x-bookmarks --remote --file db/schema.sql
       npx wrangler d1 execute x-bookmarks --remote --file data/seed.sql
"""
import base64
import glob
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))


def exported_ids(run_dir):
    ids = set()
    for f in glob.glob(os.path.join(run_dir, '*-Bookmarks-*.json')):
        for ins in json.load(open(f))['data']['bookmark_timeline_v2']['timeline']['instructions']:
            ids.update(e['entryId'][6:] for e in ins.get('entries', []) if e['entryId'].startswith('tweet-'))
    return ids


def sql(s):
    return "'" + s.replace("'", "''") + "'"


def update_data():
    items = json.load(open(os.path.join(ROOT, 'data', 'items.json')))['items']
    rows = [f"UPDATE items SET data = {sql(json.dumps({k: v for k, v in it.items() if k != 'rank'}, ensure_ascii=False))} "
            f"WHERE id = {sql(it['id'])};" for it in items]
    open(os.path.join(ROOT, 'data', 'update.sql'), 'w').write('\n'.join(rows) + '\n')
    print(f'data/update.sql: {len(rows)} items')


def main(run_dir):
    items = json.load(open(os.path.join(ROOT, 'data', 'items.json')))['items']
    vec = open(os.path.join(ROOT, 'data', 'vectors.bin'), 'rb').read()
    dim = len(vec) // len(items)
    log_path = os.path.join(ROOT, 'data', 'unbookmark-log.json')
    log = json.load(open(log_path)) if os.path.exists(log_path) else {}
    live = {i for i in exported_ids(run_dir) if log.get(i) != 'removed'}
    top = max(it['rank'] for it in items) + 1
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for i, it in enumerate(items):
        no = top - it['rank']
        data = {k: v for k, v in it.items() if k != 'rank'}
        v = base64.b64encode(vec[i * dim:(i + 1) * dim]).decode()
        rows.append(f"INSERT OR REPLACE INTO items (id, no, bookmarked, pending, data, vec, added_at) VALUES "
                    f"({sql(it['id'])}, {no}, {int(it['id'] in live)}, 0, {sql(json.dumps(data, ensure_ascii=False))}, {sql(v)}, {sql(now)});")
    open(os.path.join(ROOT, 'data', 'seed.sql'), 'w').write('\n'.join(rows) + '\n')
    print(f'data/seed.sql: {len(rows)} items, {sum(it["id"] in live for it in items)} still bookmarked, dim {dim}')


if __name__ == '__main__':
    update_data() if sys.argv[1] == '--update-data' else main(sys.argv[1])
