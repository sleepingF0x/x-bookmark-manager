"""Build a compact per-bookmark text digest (tweet + quote + article + repo info + OCR) for classification.

Writes data/digest.jsonl. Article/thread text comes from data/raw/details when captured.
Usage: python3 -I scripts/digest.py [max_chars]
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
REPO_RE = re.compile(r'github\.com/([\w.-]+)/([\w.-]+)')
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 1500


BLOCK_TYPES = {'unstyled': 'p', 'header-one': 'h2', 'header-two': 'h3', 'unordered-list-item': 'ul',
               'ordered-list-item': 'ol', 'blockquote': 'quote', 'code-block': 'code'}


def article_doc(art):
    """X Article -> {title, cover, blocks}; a block is {t, x[, l]} or an image/divider/embedded post.

    Inline link ranges (l: [[offset, length, url]]) stay in Draft.js UTF-16 offsets for the browser to apply.
    """
    images = {m.get('media_id'): m.get('media_info', {}).get('original_img_url') for m in art.get('media_entities', [])}
    ents = {str(e['key']): e['value'] for e in art['content_state'].get('entityMap', [])}
    blocks = []
    for b in art['content_state']['blocks']:
        if b['type'] == 'atomic':
            for r in b.get('entityRanges', []):
                e = ents.get(str(r['key']), {})
                if e.get('type') == 'MEDIA':
                    for mi in e['data'].get('mediaItems', []):
                        if images.get(mi.get('mediaId')):
                            blocks.append({'t': 'img', 'u': images[mi['mediaId']], 'c': e['data'].get('caption', '')})
                elif e.get('type') == 'DIVIDER':
                    blocks.append({'t': 'hr'})
                elif e.get('type') == 'TWEET':
                    blocks.append({'t': 'post', 'id': e['data'].get('tweetId')})
            continue
        if not b['text'].strip():
            continue
        block = {'t': BLOCK_TYPES.get(b['type'], 'p'), 'x': b['text']}
        links = [[r['offset'], r['length'], ents[str(r['key'])]['data'].get('url')] for r in b.get('entityRanges', [])
                 if ents.get(str(r['key']), {}).get('type') == 'LINK' and ents[str(r['key'])]['data'].get('url')]
        if links:
            block['l'] = links
        blocks.append(block)
    cover = (art.get('cover_media') or {}).get('media_info', {}).get('original_img_url')
    return {'title': art.get('title', ''), 'cover': cover, 'blocks': blocks}


def details_index():
    """tweet id -> {'article': text, 'doc': structured article, 'thread': [author self-replies]}
    from captured TweetDetail responses."""
    idx = {}
    for f in glob.glob(os.path.join(ROOT, 'data', 'raw', 'details', '*.json')):
        root_id = os.path.basename(f)[:-5]
        info = {'article': None, 'doc': None, 'thread': []}
        author = None

        def walk(o):
            nonlocal author
            if isinstance(o, dict):
                if o.get('__typename') == 'Tweet' and 'legacy' in o:
                    leg = o['legacy']
                    art = o.get('article', {}).get('article_results', {}).get('result', {})
                    if o.get('rest_id') == root_id:
                        author = leg.get('user_id_str')
                        if art.get('content_state'):
                            info['article'] = (art.get('title', '') + '\n' +
                                               '\n'.join(b['text'] for b in art['content_state']['blocks']))
                            info['doc'] = article_doc(art)
                    elif (author and leg.get('user_id_str') == author
                          and leg.get('conversation_id_str') == root_id
                          and leg.get('in_reply_to_user_id_str') == author):  # continuing the thread, not answering comments
                        note = o.get('note_tweet', {}).get('note_tweet_results', {}).get('result', {})
                        info['thread'].append((o['rest_id'], note.get('text') or leg.get('full_text', '')))
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        # Two passes: the root tweet sets `author` before self-replies are recognised.
        data = json.load(open(f))
        walk(data)
        walk(data)
        info['thread'] = [t for _, t in sorted(dict(info['thread']).items())]
        idx[root_id] = info
    return idx


def load_sources():
    tweets = json.load(open(os.path.join(ROOT, 'data', 'tweets.json')))
    gh = json.load(open(os.path.join(ROOT, 'data', 'enrich', 'github.json')))
    ocr = json.load(open(os.path.join(ROOT, 'data', 'enrich', 'ocr.json')))
    return tweets, gh, ocr, details_index()


def build_text(r, gh, ocr, det):
    parts = [f"@{r['author']['handle']} {r['created_at'][4:10]} {r['created_at'][-4:]}", r['text']]
    for rec, tag in ((r, ''), (r.get('quoted'), '[引用] ')):
        if not rec:
            continue
        if rec is not r:
            parts.append(f"{tag}@{rec['author']['handle']}: {rec['text']}")
        d = det.get(rec['id'])
        if d and d['article']:
            parts.append('[文章] ' + d['article'])
        if d and d['thread']:
            parts.append('[线程] ' + '\n'.join(d['thread']))
        for u in rec['links']:
            m = REPO_RE.search(u)
            info = m and gh.get(f"{m.group(1)}/{m.group(2).removesuffix('.git')}".lower())
            if info and not info.get('missing'):
                parts.append(f"[repo] {info['name']} ★{info['stars']} {info.get('description') or ''}")
            elif 'x.com/i/article' not in u:
                parts.append(f'[link] {u}')
        for m in rec['media']:
            if m['type'] == 'photo' and ocr.get(m['url']):
                parts.append('[图中文字] ' + ocr[m['url']].replace('\n', ' '))
            elif m['type'] != 'photo':
                parts.append('[视频]')
    return '\n'.join(p for p in parts if p)


def main():
    tweets, gh, ocr, det = load_sources()
    out = open(os.path.join(ROOT, 'data', 'digest.jsonl'), 'w')
    for r in tweets:
        if r.get('unavailable'):
            continue
        text = build_text(r, gh, ocr, det)
        out.write(json.dumps({'id': r['id'], 'rank': r['bookmark_rank'], 'text': text[:MAX]},
                             ensure_ascii=False) + '\n')
    print(f'details captured: {len(det)}, with article text: {sum(1 for d in det.values() if d["article"])}')


if __name__ == '__main__':
    main()
