"""Flatten raw GraphQL bookmark responses into data/tweets.json (one clean record per bookmark).

Usage: python3 -I scripts/normalize.py data/raw/<run-dir>
"""
import glob
import json
import os
import sys


def unwrap(result):
    # Tweets with visibility restrictions are wrapped one level deeper.
    if result and result.get('__typename') == 'TweetWithVisibilityResults':
        return result.get('tweet')
    return result


def full_text(t):
    note = t.get('note_tweet', {}).get('note_tweet_results', {}).get('result')
    if note and note.get('text'):
        return note['text'], note.get('entity_set', {})
    leg = t['legacy']
    return leg.get('full_text', ''), leg.get('entities', {})


def author(t):
    u = t.get('core', {}).get('user_results', {}).get('result', {})
    core = u.get('core') or u.get('legacy', {})
    return {'handle': core.get('screen_name'), 'name': core.get('name')}


def to_record(t):
    t = unwrap(t)
    if not t or t.get('__typename') != 'Tweet':
        return None
    leg = t['legacy']
    text, entities = full_text(t)
    links = [u['expanded_url'] for u in entities.get('urls', []) if u.get('expanded_url')]
    # Show real destinations instead of t.co wrappers.
    for u in entities.get('urls', []):
        if u.get('url') and u.get('expanded_url'):
            text = text.replace(u['url'], u['expanded_url'])
    media = []
    for m in leg.get('extended_entities', {}).get('media', []):
        item = {'type': m['type'], 'url': m['media_url_https']}
        if m['type'] in ('video', 'animated_gif'):
            variants = [v for v in m.get('video_info', {}).get('variants', []) if v.get('bitrate') is not None]
            if variants:
                item['video'] = max(variants, key=lambda v: v['bitrate'])['url']
        media.append(item)
    # t.co media links are noise once media is captured separately.
    for m in leg.get('extended_entities', {}).get('media', []):
        text = text.replace(m.get('url', '\0'), '').strip()
    a = author(t)
    quoted = t.get('quoted_status_result', {}).get('result')
    return {
        'id': t['rest_id'],
        'url': f"https://x.com/{a['handle']}/status/{t['rest_id']}",
        'author': a,
        'created_at': leg.get('created_at'),
        'lang': leg.get('lang'),
        'text': text,
        'links': links,
        'media': media,
        'quoted': to_record(quoted) if quoted else None,
        'conversation_id': leg.get('conversation_id_str'),
        'in_reply_to': leg.get('in_reply_to_status_id_str'),
        'stats': {k: leg.get(k) for k in ('favorite_count', 'retweet_count', 'bookmark_count')},
    }


def main(run_dir):
    records, seen = [], set()
    for f in sorted(glob.glob(os.path.join(run_dir, '*-Bookmarks-*.json'))):
        for ins in json.load(open(f))['data']['bookmark_timeline_v2']['timeline']['instructions']:
            for e in ins.get('entries', []):
                if not e['entryId'].startswith('tweet-'):
                    continue
                raw = e['content']['itemContent']['tweet_results'].get('result')
                rec = to_record(raw)
                tid = e['entryId'][6:]
                if tid in seen:
                    continue
                seen.add(tid)
                if rec is None:
                    rec = {'id': tid, 'unavailable': True}
                rec['bookmark_rank'] = len(records)  # 0 = most recently bookmarked
                records.append(rec)
    out = os.path.join(os.path.dirname(__file__), '..', 'data', 'tweets.json')
    json.dump(records, open(out, 'w'), ensure_ascii=False, indent=1)
    print(f'wrote {len(records)} records -> {os.path.normpath(out)}')


if __name__ == '__main__':
    main(sys.argv[1])
