# X 书签管理器

把 X（Twitter）收藏整理成一个私人知识库：自动分类、打标签、写摘要，支持关键词 + 语义搜索，按原样阅读推文和长文章，并通过 X 官方 API 与收藏夹双向同步——新收藏自动入库，在网站上清理的条目同步从 X 取消收藏，回收站可恢复。

跑在 Cloudflare 上（Pages + Functions + D1 + Workers AI），整站 Basic Auth 密码保护；分类与清理判断用你自己的 OpenAI / Anthropic 兼容模型接口。

## 功能

- **三栏阅读**：分类 / 列表 / 阅读区。阅读区按推文结构渲染：正文与链接、图片宫格、可播放的视频、引用卡片、X 长文章（标题层级、列表、插图、文内链接）、作者自己续写的线程、GitHub 仓库卡片，底部列出语义最接近的相关收藏。键盘 `↑` `↓` 切换，`/` 搜索；手机上阅读区全屏覆盖。
- **搜索**：关键词 + 语义（`bge-m3` 向量，在浏览器里算余弦相似度），可叠加分类、类型、价值、标签筛选。
- **同步**：打开网站时若距上次同步超过 12 小时，增量拉取新收藏，用你的模型分类、打标签、写摘要、生成向量。「全量核对」可找出在 X 上直接取消或重新收藏的条目。
- **清理**：模型把内容标为保留 / 过期 / 垃圾。「待清理」列出候选，「重新分析」按今天的日期把整个库重判一遍（很多内容是随时间才过期的）。移到回收站时从 X 取消收藏；恢复时重新收藏到 X；点过「保留」的条目不会再被提示。
- **费用控制**：X API 读写都有代码层面的月度硬上限，侧栏显示本月用量和余额。

## 怎么开始

每个人部署自己的一份：自己的 Cloudflare、自己的 X 开发者 App、自己的模型接口，数据只在自己的账号里。你需要准备：

| 准备 | 说明 | 费用 |
|---|---|---|
| Cloudflare 账号 | Pages、D1、Workers AI | 个人用量在免费额度内 |
| X 开发者账号 + 一个 App | [console.x.com](https://console.x.com)，充值一次按量额度（首次充值另送额度） | 读收藏 $0.001/条，日常约每月 $0.3 |
| 模型接口 | 任意 OpenAI 或 Anthropic 兼容接口（DeepSeek、OpenRouter、官方 API 等） | 取决于你的接口，量很小 |
| Node.js 22+ | 部署用 | — |

然后二选一导入已有收藏：

- **只用网站（推荐给大多数人，任何系统都行）**：按下面「部署」做完，打开网站点「连接 X」。数据库是空的，第一次同步会从最新往前把收藏一页页全部拉进来，再分批用你的模型整理。
  - 首次导入前把 `X_MONTHLY_READ_CAP` 临时调到收藏数的 3 倍左右（计数包含作者和被引用的帖子），否则默认的 1500 会在七八百条处停下；导完再改回来。
  - 一次同步最多翻约 2700 条；收藏更多时，之后点一次「全量核对」补齐剩下的。
  - 每次同步最多整理 600 条，剩下的显示为「待整理」，再点一次「同步」继续。
  - 这条路径的代码与日常增量同步相同，但还没有在上千条的新库上完整跑过；遇到问题欢迎提 issue。
- **本地流水线（macOS + Chrome）**：内容更完整（长文章全文、作者线程、图片文字辅助分类、GitHub 仓库信息），见下方「首次导入已有收藏」。

## 架构

```
浏览器 (site/index.html)
   │  Basic Auth (functions/_middleware.js)
   ▼
Cloudflare Pages Functions (functions/, lib/)
   ├─ D1          items：每条收藏一行（结构化内容 JSON + 向量 + X 状态 + 回收站）
   │              meta ：OAuth token、同步记录、月度用量
   ├─ Workers AI  @cf/baai/bge-m3 向量（入库与搜索词）
   ├─ X API v2    OAuth 2.0 PKCE；读收藏、取消/恢复收藏
   └─ 你的 LLM     新收藏分类、清理判断

本地流水线 (scripts/)：首次把已有收藏完整导入（浏览器导出 + 长文章/线程补全 + OCR + GitHub 信息 + 分类）
```

## 目录结构

```
site/index.html            前端单页（无构建步骤）
functions/
  _middleware.js           整站 Basic Auth，密码取自 SITE_PASSWORD；未设置时一律拒绝
  api/items.js             整个库（含向量）
  api/embed.js             搜索词向量
  api/trash.js restore.js  回收站：移入（并从 X 取消收藏）/ 恢复（并重新收藏）
  api/purge.js keep.js     彻底删除 / 标记保留
  api/analyze.js           重新分析一批（清理判断）
  api/x/login.js callback.js   X OAuth
  api/x/sync.js            增量同步 / 全量核对
  api/x/process.js         为新条目分类 + 生成向量
  api/x/status.js          连接、用量、余额
  api/x/llmcheck.js        模型诊断：连通性、?models=1 列模型、?compare=N 与现有标签对比
lib/
  x.js                     X API 客户端（OAuth、token 刷新、字段命名兼容）
  items.js                 API 返回 → 库条目；分类与向量化
  llm.js                   模型调用（OpenAI / Anthropic 格式）与提示词
  store.js                 D1 辅助、锁、月度预算
  ids.js                   批量请求参数校验
db/schema.sql              D1 表结构；db/migrations/ 是对已有库的增量变更
scripts/                   本地导入流水线（见下）
wrangler.example.toml      复制为 wrangler.toml 并填入你的 D1 id
data/                      你的个人数据（不入库，见 .gitignore）
```

## 部署

需要：Node.js 22+（脚本用到内置 WebSocket）、Python 3.10+、Cloudflare 账号、X 开发者账号（按量付费额度）、一个 OpenAI 或 Anthropic 兼容的模型接口。

```bash
# 1. Cloudflare 资源
git clone https://github.com/sleepingF0x/x-bookmark-manager.git && cd x-bookmark-manager
npx wrangler login
npx wrangler d1 create x-bookmarks          # 记下 database_id
cp wrangler.example.toml wrangler.toml      # 填入 database_id
npx wrangler d1 execute x-bookmarks --remote --file db/schema.sql
npx wrangler pages project create x-bookmarks --production-branch main

# 2. 首次部署，得到 https://<项目>.pages.dev
npx wrangler pages deploy
```

**3. 配置 secrets**：在 Cloudflare 后台 Workers & Pages → 项目 → Settings → Variables and Secrets（Production，类型选 Secret），或用 `npx wrangler pages secret put <名字> --project-name x-bookmarks`。改完需要重新部署才生效。

| 名字 | 内容 |
|---|---|
| `SITE_PASSWORD` | 网站密码（用户名任意） |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X 开发者后台 App 的 OAuth 2.0 Client ID / Secret |
| `LLM_BASE_URL` | OpenAI 兼容填到 `/v1`（如 `https://api.openai.com/v1`）；Anthropic 兼容填根地址（如 `https://api.anthropic.com`） |
| `LLM_API_KEY` / `LLM_MODEL` | 模型接口的 key 与模型名（`/api/x/llmcheck?models=1` 可列出可用模型） |
| `LLM_FORMAT` | 可选，`openai` 或 `anthropic`；不填时 URL 含 anthropic 即按 Anthropic 格式 |
| `X_MONTHLY_READ_CAP` / `X_MONTHLY_WRITE_CAP` | 可选，月度上限，默认 1500 / 200 |

**4. X App 设置**（[console.x.com](https://console.x.com) → 你的 App → User authentication settings）：
- App permissions：Read and write
- Type of App：Web App, Automated App or Bot
- Callback URI：`https://<项目>.pages.dev/api/x/callback`（必须一字不差）
- Website URL：任意，比如你的 GitHub 主页

**5.** 重新部署，打开网站，点左下角「连接 X」授权。授权页的「我信任此应用」勾不上时，多半是广告拦截类插件拦了 X 的脚本，临时关掉即可（授权只需一次）。

## 首次导入已有收藏（本地流水线）

比网站同步导入的内容更完整（X 长文章全文、作者线程、图片 OCR 辅助分类、GitHub 仓库信息），适合收藏多、在意长文章的情况。

前提：macOS + Chrome（浏览器脚本从 `~/Library/Application Support/Google/Chrome/DevToolsActivePort` 找调试端口，OCR 用 macOS Vision）。在你日常使用、已登录 X 的 Chrome 里打开 `chrome://inspect/#remote-debugging` 开启远程调试；脚本每次连接时 Chrome 会弹窗确认。脚本只在新窗口里浏览，不碰你已打开的标签页。

```bash
# 导出：滚动收藏页，保存 X 返回的原始数据
node scripts/export-bookmarks.mjs                          # -> data/raw/<时间戳>/
python3 -I scripts/normalize.py data/raw/<时间戳>           # -> data/tweets.json

# 补全：长文章与线程（浏览器逐条打开），GitHub 信息与图片 OCR（本地，OCR 需要 macOS）
python3 -I scripts/detail_queue.py data/raw/<时间戳>        # -> data/detail-queue.json
node scripts/capture-details.mjs data/detail-queue.json    # 已抓过的会跳过
python3 -I scripts/enrich_offline.py                       # 需要已登录的 gh CLI

# 分类：用 Claude Code 的 claude -p（结构化输出），只处理还没分类的
python3 -I scripts/digest.py 1200
python3 -I scripts/classify.py

# 生成并写入 D1
python3 -I scripts/build_site.py                           # -> data/items.json
CLOUDFLARE_ACCOUNT_ID=<id> python3 -I scripts/embed.py     # -> data/vectors.bin
python3 -I scripts/seed_d1.py data/raw/<时间戳>             # -> data/seed.sql
npx wrangler d1 execute x-bookmarks --remote --file data/seed.sql
```

注意 X 会对短时间内大量打开页面限流（经验上一小时几百个页面后开始拿不到数据），`capture-details` 和导出都别连续跑太多次。

只调整了条目的数据结构、需要更新已有库时：`python3 -I scripts/seed_d1.py --update-data` 生成 `data/update.sql`，只替换内容 JSON，不动 X 状态、回收站和向量。

## 清理与回收站

- **待清理**：模型标为过期 / 垃圾、你没点过「保留」、也不在回收站的条目。默认全选，取消勾选想留的，或点「保留」让它以后不再出现。
- **重新分析**：用你的模型按今天的日期重判整个库（每批 25 条，3 批并行，约 700 条 3 分钟）。只改清理判断，不动分类和标签；结果只是建议，不会自动删除。
- **移到回收站**：从知识库隐藏，同时通过 API 从 X 取消收藏。X 调用失败的会标「X 上未移除」，再移一次即重试。
- **恢复**：回到知识库、标为保留，并重新收藏到 X（会出现在 X 收藏列表最前面；原帖已删除时只恢复到知识库）。
- **彻底删除**：从数据库删除，只对已不在 X 收藏里的条目生效，无法找回。

API 不可用时的备用方案：`node scripts/unbookmark.mjs` 在你的 Chrome 里逐条点掉「在回收站但仍在 X 收藏中」的条目，完成后回写 D1。前 5 条是试运行，出现异常结果立即停止；`--dry-run` 只定位按钮、不点击。

## 费用

X API 是预充值、按量扣费，**不开 auto-recharge 就不会自动扣卡**。实测读取自己的收藏 $0.001/条；取消或恢复收藏 $0.005/次。

| 操作 | 大约花费 |
|---|---|
| 一次增量同步（读最新 10 条，碰到已收录的就停） | $0.01 |
| 一次全量核对（只读 id 列表） | 收藏数 × $0.001 |
| 移到回收站 / 恢复 | 每条 $0.005 |
| 日常使用（每月几十条新收藏） | 每月 $0.3 左右 |

Cloudflare 部分在免费额度内；模型调用走你自己的接口。代码里的月度上限到了就拒绝调用 X API，和 X 后台的消费上限互相独立，建议两边都设。

## 本地开发

```bash
printf 'SITE_PASSWORD=dev\n' > .dev.vars                     # 可再加 LLM_* / X_* 用于本地调试
npx wrangler d1 execute x-bookmarks --local --file db/schema.sql
npx wrangler d1 execute x-bookmarks --local --file data/seed.sql
npx wrangler pages dev --port 8788                           # http://localhost:8788，Workers AI 走远程
```

## 安全

- 所有凭据（网站密码、X Client Secret、模型 key）只存为 Cloudflare 加密 secret，不写进代码或仓库。X 的 OAuth token 存在你自己的 D1 里。
- 整站（包括静态文件和全部 API）都在 Basic Auth 之后；`SITE_PASSWORD` 未设置时一律返回 401。
- `data/` 是你的个人数据（收藏原文、图片、日志、数据库导出），已在 `.gitignore` 中排除。**数据库导出文件包含 OAuth token，不要分享。**

## 已知限制

- 通过 API 同步进来的 X 长文章，正文结构是否完整未经验证；本地流水线抓取的是完整结构。
- 新同步的条目没有图片 OCR，分类和清理判断只看文字；提示词已要求模型不要仅因正文没写清就判为垃圾。
- 被删除或设为私密的推文仍会占着 X 收藏列表的位置，但拿不到内容，不会进入知识库。

## 许可

[MIT](LICENSE)
