"""Classify bookmarks with headless Claude Code (`claude -p`, structured JSON output).

Reads data/digest.jsonl, writes data/enrich/labels.json; reruns only process unlabeled ids.
Usage: python3 -I scripts/classify.py [--limit N] [--workers 4] [--model sonnet]
"""
import argparse
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import date

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
LABELS = os.path.join(ROOT, 'data', 'enrich', 'labels.json')
BATCH = 25

CATEGORIES = [
    'AI 编程与 Agent', 'AI 创作与应用', '开发与开源工具', '加密与 Web3', '投资理财与出入金',
    '网络与服务器', '副业、创业与个人品牌', '职场与求职', '数码与效率技巧', '健康与生活',
    '学习与阅读', '娱乐与杂项',
]
TYPES = ['工具/项目', '教程/方法', '资源合集', '观点/经验', '资讯']

SCHEMA = {
    'type': 'object',
    'required': ['items'],
    'properties': {'items': {'type': 'array', 'items': {
        'type': 'object',
        'required': ['id', 'category', 'tags', 'type', 'title', 'summary', 'score', 'cleanup', 'cleanup_reason'],
        'properties': {
            'id': {'type': 'string'},
            'category': {'enum': CATEGORIES},
            'tags': {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 5},
            'type': {'enum': TYPES},
            'title': {'type': 'string'},
            'summary': {'type': 'string'},
            'score': {'type': 'integer', 'minimum': 1, 'maximum': 5},
            'cleanup': {'enum': ['keep', 'expired', 'junk']},
            'cleanup_reason': {'type': 'string'},
        },
    }}},
}

SYSTEM = f"""你在帮用户整理 X（推特）收藏，建个人知识库。今天是 {date.today().isoformat()}。
每条收藏给出：作者、发布日期、正文，以及补全内容（[引用] 被引用推文、[文章] X 长文章全文、[线程] 作者后续回复、[repo] GitHub 仓库信息、[link] 外链、[图中文字] 图片 OCR、[视频] 含视频但无转写）。

对每条输出：
- category：从给定 12 类中选最贴切的一个。
- tags：2-5 个中文或通用英文关键词，用于检索；优先用具体名词（产品名、技术名、币种、平台），不要用“AI”“分享”这类泛词。同一事物统一写法（如 Claude Code、OpenClaw、DeFi、港卡）。
- type：内容类型。
- title：不超过 25 字的中文标题，概括这条讲什么（不是照抄第一句）。
- summary：1-2 句中文，说清楚“具体是什么 + 对读者有什么用”，不超过 80 字。
- title、summary、cleanup_reason 用中文全角标点（，：；（）），不要用半角逗号、冒号。
- score：作为知识库的长期价值。5=高质量深度内容或常用利器；3=有参考价值；1=几乎无信息。
- cleanup：
  - junk：没有可检索的知识价值——纯娱乐/搞笑/颜值视频、情绪感慨、广告推销、无实质内容的标题党、补全后仍无内容。
  - expired：内容价值依赖时效且已过期——已结束的空投/积分/撸毛交互/抢购/促销/NFT 铸造/活动；一次性新闻快讯；明确被新版本取代的工具或模型用法（对照今天的日期判断）；内容以过时信息为核心的文章。
  - keep：其余。拿不准时选 keep。发布不满 30 天的资讯/活动还在时效内，不算 expired。
  “娱乐与杂项”也要逐条判断：有具体可用信息（如旅行攻略、实用冷知识）的仍是 keep。
- cleanup_reason：cleanup 不是 keep 时用一句话说明理由，否则为空字符串。

必须覆盖输入里的每一个 id，原样返回 id。"""


def load_labels():
    return json.load(open(LABELS)) if os.path.exists(LABELS) else {}


def run_batch(batch, model):
    prompt = '\n\n'.join(f"<item id=\"{d['id']}\">\n{d['text']}\n</item>" for d in batch)
    p = subprocess.run(
        ['claude', '-p', '--model', model, '--output-format', 'json',
         '--json-schema', json.dumps(SCHEMA, ensure_ascii=False),
         '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config',
         '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''],
        input=prompt, capture_output=True, text=True, cwd='/tmp')
    if p.returncode != 0:
        return batch, None, p.stderr[-500:] or p.stdout[-500:]
    out = json.loads(p.stdout)
    items = (out.get('structured_output') or {}).get('items')
    if items is None:
        return batch, None, f"no structured_output: {str(out.get('result'))[:300]}"
    return batch, items, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int)
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--model', default='sonnet')
    args = ap.parse_args()

    labels = load_labels()
    todo = [json.loads(l) for l in open(os.path.join(ROOT, 'data', 'digest.jsonl'))]
    todo = [d for d in todo if d['id'] not in labels][:args.limit]
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f'{len(todo)} to label in {len(batches)} batches')

    with ThreadPoolExecutor(args.workers) as ex:
        for batch, items, err in ex.map(lambda b: run_batch(b, args.model), batches):
            if err:
                print('batch failed:', err)
                continue
            want = {d['id'] for d in batch}
            got = {it['id']: it for it in items if it['id'] in want}
            labels.update(got)
            json.dump(labels, open(LABELS, 'w'), ensure_ascii=False, indent=1)
            print(f'batch ok: {len(got)}/{len(want)} labeled' + ('' if len(got) == len(want) else ' (missing ids will retry on rerun)'))
    print(f'total labeled: {len(labels)}')


if __name__ == '__main__':
    main()
