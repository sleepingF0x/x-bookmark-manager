# X 书签管理器

把 X（Twitter）收藏整理成一个私人知识库：自动分类、打标签、写摘要，支持关键词 + 语义搜索，按原样阅读推文和长文章，并通过 X 官方 API 与收藏夹双向同步——新收藏自动入库，在网站上清理的条目同步从 X 取消收藏，回收站可恢复。

可以一键部署到 Cloudflare Workers（D1 + Workers AI），也可以用 Docker 跑在自己的服务器或电脑上；整站 Basic Auth 密码保护；分类与清理判断用你自己的 OpenAI / Anthropic 兼容模型接口。

## 功能

- **三栏阅读**：分类 / 列表 / 阅读区。阅读区按推文结构渲染：正文与链接、图片宫格、可播放的视频、引用卡片、X 长文章（标题层级、列表、插图、文内链接）、作者自己续写的线程、GitHub 仓库卡片，底部列出语义最接近的相关收藏。键盘 `↑` `↓` 切换，`/` 搜索；手机上阅读区全屏覆盖。
- **搜索**：关键词 + 语义（`bge-m3` 向量，在浏览器里算余弦相似度），可叠加分类、类型、价值、标签筛选。
- **同步**：打开网站时若距上次同步超过 12 小时，增量拉取新收藏，用你的模型分类、打标签、写摘要、生成向量。「全量核对」可找出在 X 上直接取消或重新收藏的条目。
- **清理**：模型把内容标为保留 / 过期 / 垃圾。「待清理」列出候选，「重新分析」按今天的日期把整个库重判一遍（很多内容是随时间才过期的）。移到回收站时从 X 取消收藏；恢复时重新收藏到 X；点过「保留」的条目不会再被提示。
- **费用控制**：X API 读写都有代码层面的月度硬上限，侧栏显示本月用量和余额。

## 怎么开始

每个人部署自己的一份：自己的服务器或 Cloudflare 账号、自己的 X 开发者 App、自己的模型接口，数据只在自己手里。

**先准备好这几样：**

| 准备 | 说明 | 费用 |
|---|---|---|
| X 开发者 App | [console.x.com](https://console.x.com) 创建 App，预充值少量按量额度（部分账号会附赠额度，以后台显示为准） | 读收藏 $0.001/条，日常约每月 $0.3 |
| 模型接口 | 任意 OpenAI 或 Anthropic 兼容接口（DeepSeek、OpenRouter、官方 API 等），用于分类和清理判断 | 取决于你的接口，量很小 |
| Cloudflare 账号 | 方式一托管整个应用；方式二、三只用它的 Workers AI 生成搜索向量 | 个人用量在免费额度内 |

**再选一种部署方式：**

| | 方式一：Cloudflare Workers | 方式二：Docker + 自己的服务器 | 方式三：Docker 在自己电脑上 |
|---|---|---|---|
| 适合 | 大多数人 | 想把数据放在自己的服务器上 | 只在一台电脑上用 |
| 需要 | 只要 Cloudflare 账号 | 一台开放 80/443 的服务器 + 一个域名 | 装好 Docker |
| HTTPS | 自带 `*.workers.dev` | Caddy 自动申请证书 | 不需要（X 允许 `http://127.0.0.1` 回调） |
| 数据存在 | Cloudflare D1 | 服务器上的 SQLite 文件 | 本机的 SQLite 文件 |
| 费用 | 免费额度内 | 服务器费用 | 无 |

### 新手 6 步（以方式一为例，约 20–30 分钟）

1. **准备账号**：GitHub（部署按钮会把仓库复制到你名下）、Cloudflare（免费版即可）、X 开发者账号（用你的 X 账号登录 [console.x.com](https://console.x.com) 开通）、一个模型接口的 key。
2. **创建 X App 并充值**：按下方「[X App 设置](#x-app-设置三种方式都要)」填写，Callback URI 先填 `http://127.0.0.1:8787/api/x/callback` 占位，第 4 步再改；记下 Client ID 和 Client Secret。充值少量额度（比如 $5），**不要开 auto-recharge**。
3. **部署**：点下方「[Deploy to Cloudflare](#方式一cloudflare-workers推荐)」按钮，在表单里填网站密码、X 的 Client ID / Secret、模型接口（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`）。完成后得到 `https://x-bookmark-manager.<你的子域>.workers.dev`。
4. **改回调地址**：回到 X App，把 Callback URI 改成 `<你的网站地址>/api/x/callback`，必须一字不差。
5. **导入收藏**：先在 Cloudflare 后台 Workers & Pages → x-bookmark-manager → Settings → Variables and Secrets 加一个变量 `X_MONTHLY_READ_CAP`，值设为收藏数的 3 倍左右（默认 1500 只够导七八百条，导完再删掉）。然后打开网站，用你的密码登录（用户名任意），点左下角「连接 X」并授权，再点「同步」。每次同步最多整理 600 条，显示「待整理」时再点一次「同步」继续。细节见「[导入已有收藏](#导入已有收藏)」。
6. **清理**：打开「待清理」，模型判为过期或垃圾的条目默认全选；取消勾选想留的，或点「保留」让它以后不再出现，然后点「移到回收站」，这些条目会同时从 X 收藏夹取消。回收站里点「恢复」会重新收藏到 X，确认无误后再「彻底删除」。细节见「[清理与回收站](#清理与回收站)」。

以 1000 条收藏为例：首次导入约 $1–3，清理 200 条约 $1（每条 $0.005），之后日常每月几毛钱。用 Docker 部署时第 3 步换成下方方式二或三，其余步骤相同；Docker 版回调地址里的网站地址就是你的 `PUBLIC_URL`。

## 部署

### X App 设置（三种方式都要）

在 [console.x.com](https://console.x.com) → 你的 App → User authentication settings：

- App permissions：**Read and write**
- Type of App：**Web App, Automated App or Bot**
- Callback URI：`<你的网站地址>/api/x/callback`，必须一字不差（网站地址见各方式）
- Website URL：任意，比如你的 GitHub 主页

保存后在 Keys and tokens 页拿到 OAuth 2.0 的 **Client ID** 和 **Client Secret**。

### 方式一：Cloudflare Workers（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sleepingF0x/x-bookmark-manager)

1. 点上面的按钮，登录 Cloudflare。它会把仓库复制到你的 GitHub、自动创建 D1 数据库，并让你填写：网站密码、X 的 Client ID / Secret、模型接口（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`）。
2. 部署完成后得到 `https://x-bookmark-manager.<你的子域>.workers.dev`，把 `这个地址/api/x/callback` 填回 X App 的 Callback URI。
3. 打开网站，用你设的密码登录（用户名任意），点「连接 X」。

也可以用命令行部署：

```bash
git clone https://github.com/sleepingF0x/x-bookmark-manager.git && cd x-bookmark-manager
npm install
npx wrangler login
npx wrangler d1 create x-bookmark-manager      # 把输出的 database_id 填进 wrangler.jsonc
npm run deploy                                 # 建表（D1 migrations）+ 部署
for s in SITE_PASSWORD X_CLIENT_ID X_CLIENT_SECRET LLM_BASE_URL LLM_API_KEY LLM_MODEL; do npx wrangler secret put $s; done
```

之后改配置：Cloudflare 后台 Workers & Pages → x-bookmark-manager → Settings → Variables and Secrets。

### 方式二：Docker + 自己的服务器（自动 HTTPS）

需要一台开放了 80/443 端口的服务器，并把一个域名解析到它。

```bash
git clone https://github.com/sleepingF0x/x-bookmark-manager.git && cd x-bookmark-manager
cp .env.example .env     # 填 DOMAIN、PUBLIC_URL=https://<DOMAIN>、密码、X、模型、Cloudflare Workers AI
docker compose up -d
```

[Caddy](https://caddyserver.com) 自动申请并续期证书，网站地址就是 `https://<DOMAIN>`。数据在 `./storage/x-bookmarks.db`，备份复制这个目录即可。

### 方式三：Docker 在自己电脑上

```bash
cp .env.example .env     # 保持 PUBLIC_URL=http://127.0.0.1:8787，填密码、X、模型、Cloudflare Workers AI
docker run -d --name x-bookmark-manager --restart unless-stopped \
  -p 127.0.0.1:8787:8787 --env-file .env -v "$PWD/storage:/data" \
  ghcr.io/sleepingf0x/x-bookmark-manager:latest
```

网站地址 `http://127.0.0.1:8787`，X App 的 Callback URI 填 `http://127.0.0.1:8787/api/x/callback`。不用 Docker 也行：Node.js 22.13+ 下 `npm start`（读取同样的环境变量）。

### 配置项

| 名字 | 说明 |
|---|---|
| `SITE_PASSWORD` | 网站密码（用户名任意）。未设置时一律拒绝访问 |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X App 的 OAuth 2.0 Client ID / Secret |
| `LLM_BASE_URL` | OpenAI 兼容填到 `/v1`（如 `https://api.openai.com/v1`）；Anthropic 兼容填根地址（如 `https://api.anthropic.com`） |
| `LLM_API_KEY` / `LLM_MODEL` | 模型接口的 key 与模型名；部署后访问 `/api/x/llmcheck?models=1` 可列出可用模型 |
| `LLM_FORMAT` | 可选，`openai` 或 `anthropic`；不填时 URL 含 anthropic 即按 Anthropic 格式 |
| `X_MONTHLY_READ_CAP` / `X_MONTHLY_WRITE_CAP` | 可选，X API 月度上限，默认 1500 / 200 |
| `PUBLIC_URL` | 仅 Docker：网站的公开地址，用来生成 X 回调地址 |
| `DOMAIN` | 仅 docker-compose：Caddy 申请证书的域名 |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | 仅 Docker：调用 Workers AI 生成搜索向量（`@cf/baai/bge-m3`，与 Cloudflare 版同一模型）。Token 需要 Workers AI 读权限 |
| `DB_PATH` / `PORT` | 仅 Docker / Node：数据库文件路径（镜像内默认 `/data/x-bookmarks.db`）与端口（默认 8787） |

### 连接 X 时的常见问题

- 授权页提示「你无法获得该应用的访问权限」：多半是 Callback URI 和网站地址不一致（`https`、末尾斜杠、域名拼写）。
- 授权页的「我信任此应用」勾不上：广告拦截或隐私类浏览器插件拦了 X 的脚本，临时关掉即可。授权只需一次，之后的同步都在服务端完成。

## 导入已有收藏

**方法 A：直接用网站同步（任何系统）**。数据库为空时，第一次同步会从最新往前把收藏一页页全部拉进来，再分批用你的模型整理。

- 首次导入前把 `X_MONTHLY_READ_CAP` 临时调到收藏数的 3 倍左右（计数包含作者和被引用的帖子），否则默认的 1500 会在七八百条处停下；导完再改回来。
- 一次同步最多翻约 2700 条；收藏更多时，之后点一次「全量核对」补齐剩下的。
- 每次同步最多整理 600 条，剩下的显示为「待整理」，再点一次「同步」继续。
- 这条路径的代码与日常增量同步相同，但还没有在上千条的新库上完整跑过；遇到问题欢迎提 issue。

**方法 B：本地流水线（macOS + Chrome）**。比网站同步导入的内容更完整（X 长文章全文、作者线程、图片 OCR 辅助分类、GitHub 仓库信息），适合收藏多、在意长文章的情况。

前提：Node.js 22+、Python 3.10+、macOS + Chrome（浏览器脚本从 `~/Library/Application Support/Google/Chrome/DevToolsActivePort` 找调试端口，OCR 用 macOS Vision）。在你日常使用、已登录 X 的 Chrome 里打开 `chrome://inspect/#remote-debugging` 开启远程调试；脚本每次连接时 Chrome 会弹窗确认。脚本只在新窗口里浏览，不碰你已打开的标签页。

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

# 生成数据
python3 -I scripts/build_site.py                           # -> data/items.json
CLOUDFLARE_ACCOUNT_ID=<id> python3 -I scripts/embed.py     # -> data/vectors.bin
python3 -I scripts/seed_d1.py data/raw/<时间戳>             # -> data/seed.sql

# 写入数据库（按你的部署方式选一条）
npx wrangler d1 execute DB --remote --file data/seed.sql                # Cloudflare
node scripts/apply-sql.mjs storage/x-bookmarks.db data/seed.sql        # Docker（在 docker compose 目录下）
```

注意 X 会对短时间内大量打开页面限流（经验上一小时几百个页面后开始拿不到数据），`capture-details` 和导出都别连续跑太多次。

只调整了条目的数据结构、需要更新已有库时：`python3 -I scripts/seed_d1.py --update-data` 生成 `data/update.sql`，只替换内容 JSON，不动 X 状态、回收站和向量。

## 清理与回收站

- **待清理**：模型标为过期 / 垃圾、你没点过「保留」、也不在回收站的条目。默认全选，取消勾选想留的，或点「保留」让它以后不再出现。
- **重新分析**：用你的模型按今天的日期重判整个库（每批 25 条，3 批并行，约 700 条 3 分钟）。只改清理判断，不动分类和标签；结果只是建议，不会自动删除。
- **移到回收站**：从知识库隐藏，同时通过 API 从 X 取消收藏。X 调用失败的会标「X 上未移除」，再移一次即重试。
- **恢复**：回到知识库、标为保留，并重新收藏到 X（会出现在 X 收藏列表最前面；原帖已删除时只恢复到知识库）。
- **彻底删除**：从数据库删除，只对已不在 X 收藏里的条目生效，无法找回。

API 不可用时的备用方案（Cloudflare 版）：`node scripts/unbookmark.mjs` 在你的 Chrome 里逐条点掉「在回收站但仍在 X 收藏中」的条目，完成后回写 D1。前 5 条是试运行，出现异常结果立即停止；`--dry-run` 只定位按钮、不点击。

## 费用

X API 是预充值、按量扣费，**不开 auto-recharge 就不会自动扣卡**。实测读取自己的收藏 $0.001/条；取消或恢复收藏 $0.005/次。

| 操作 | 大约花费 |
|---|---|
| 一次增量同步（读最新 10 条，碰到已收录的就停） | $0.01 |
| 一次全量核对（只读 id 列表） | 收藏数 × $0.001 |
| 移到回收站 / 恢复 | 每条 $0.005 |
| 日常使用（每月几十条新收藏） | 每月 $0.3 左右 |

Cloudflare（Workers、D1、Workers AI）在免费额度内；模型调用走你自己的接口。代码里的月度上限到了就拒绝调用 X API，和 X 后台的消费上限互相独立，建议两边都设。

## 架构

```
浏览器 (site/index.html)
   │  Basic Auth（src/auth.js，静态文件也在密码之后）
   ▼
src/app.js  路由 + 全部 API（两个版本共用）
   ├─ src/worker.js  Cloudflare 入口：D1、Workers AI binding、静态资源
   └─ src/node.js    Docker / Node 入口：SQLite（src/node/d1.js，兼容 D1 接口）、Workers AI REST（src/node/ai.js）
         │
         ├─ 数据库   items：每条收藏一行（结构化内容 JSON + 向量 + X 状态 + 回收站）
         │          meta ：OAuth token、同步记录、月度用量
         ├─ Workers AI  @cf/baai/bge-m3 向量（入库与搜索词）
         ├─ X API v2    OAuth 2.0 PKCE；读收藏、取消/恢复收藏
         └─ 你的 LLM     新收藏分类、清理判断

scripts/  本地导入流水线（浏览器导出 + 长文章/线程补全 + OCR + GitHub 信息 + 分类）
```

## 目录结构

```
site/index.html              前端单页（无构建步骤）
src/
  app.js                     路由；auth.js 整站 Basic Auth
  worker.js                  Cloudflare Workers 入口
  node.js                    Node / Docker 入口；node/d1.js、node/ai.js 是 D1 与 Workers AI 的替身
  api/items.js embed.js      整个库（含向量）/ 搜索词向量
  api/trash.js restore.js    回收站：移入（并从 X 取消收藏）/ 恢复（并重新收藏）
  api/purge.js keep.js       彻底删除 / 标记保留
  api/analyze.js             重新分析一批（清理判断）
  api/x/login.js callback.js X OAuth
  api/x/sync.js process.js   同步 / 为新条目分类 + 生成向量
  api/x/status.js llmcheck.js  连接与用量 / 模型诊断（?models=1 列模型，?compare=N 与现有标签对比）
  lib/                       X API 客户端、条目转换、模型调用与提示词、存储与月度预算
migrations/                  数据库表结构（D1 migrations；Node 版启动时自动执行）
scripts/                     本地导入流水线；apply-sql.mjs 把 SQL 导入 Docker 版数据库
wrangler.jsonc  package.json Cloudflare 配置（database_id 是占位符，部署按钮会自动替换）
Dockerfile  docker-compose.yml  deploy/Caddyfile  .env.example   Docker 部署
.github/workflows/           CI（两个版本的冒烟测试）与镜像发布（ghcr.io）
```

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars        # 至少填 SITE_PASSWORD
npm run dev                           # Cloudflare 版：http://localhost:8787（本地 D1，Workers AI 走远程）
SITE_PASSWORD=dev npm start           # Node 版：http://localhost:8787（storage/x-bookmarks.db）
```

## 安全

- 所有凭据（网站密码、X Client Secret、模型 key）只放在 Cloudflare 加密 secret 或你自己的 `.env` 里，不写进代码或仓库。X 的 OAuth token 存在你自己的数据库里。
- 整站（包括静态文件和全部 API）都在 Basic Auth 之后；`SITE_PASSWORD` 未设置时一律返回 401。
- `data/`（本地流水线的个人数据）、`storage/`（Docker 版数据库）、`.env`、`.dev.vars` 都在 `.gitignore` 中。**数据库文件和导出包含 OAuth token，不要分享。**

## 已知限制

- 通过 API 同步进来的 X 长文章，正文结构是否完整未经验证；本地流水线抓取的是完整结构。
- 新同步的条目没有图片 OCR，分类和清理判断只看文字；提示词已要求模型不要仅因正文没写清就判为垃圾。
- 被删除或设为私密的推文仍会占着 X 收藏列表的位置，但拿不到内容，不会进入知识库。

## 许可

[MIT](LICENSE)
