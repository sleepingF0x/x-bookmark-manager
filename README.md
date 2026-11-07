# X 书签管理器

把 X（Twitter）收藏整理成一个私人知识库：自动分类、打标签、写摘要，支持关键词 + 语义搜索，按原样阅读推文和长文章，并通过 X 官方 API 与收藏夹双向同步——新收藏自动入库，在网站上清理的条目同步从 X 取消收藏，回收站可恢复。

可以一键部署到 Cloudflare Workers（D1 + Workers AI），也可以用 Docker 跑在自己的服务器或电脑上；整站密码保护，Cloudflare 版也可以改用 Cloudflare Access 登录（邮箱验证码、Cloudflare 账号或 Google / GitHub 等）；分类与清理判断用你自己的 OpenAI / Anthropic 兼容模型接口。

## 导航

[怎么开始](#怎么开始) · [部署](#部署) · [导入已有收藏](#导入已有收藏) · [清理与回收站](#清理与回收站) · [费用](#费用) · [架构](#架构)

## 功能

- **三栏阅读**：分类 / 列表 / 阅读区。阅读区按推文结构渲染：正文与链接、图片宫格、可播放的视频、引用卡片、X 长文章（标题层级、列表、插图、文内链接）、作者自己续写的线程、GitHub 仓库卡片，底部列出语义最接近的相关收藏。键盘 `↑` `↓` 切换，`/` 搜索；手机上阅读区全屏覆盖。
- **搜索**：关键词 + 语义（`bge-m3` 向量，在浏览器里算余弦相似度），可叠加分类、类型、价值、标签筛选。
- **同步**：打开网站时若距上次同步超过 12 小时，增量拉取新收藏，用你的模型分类、打标签、写摘要、生成向量。「全量核对」可找出在 X 上直接取消或重新收藏的条目：你在 X 上取消的收藏会跟着移到回收站，原帖已被删除的留在知识库。
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
3. **部署**：点下方「[Deploy to Cloudflare](#方式一cloudflare-workers推荐)」按钮，在表单里填网站密码和 X 的 Client ID / Secret。完成后得到 `https://x-bookmark-manager.<你的子域>.workers.dev`。
4. **改回调地址**：回到 X App，把 Callback URI 改成 `<你的网站地址>/api/x/callback`，必须一字不差。
5. **填模型、导入收藏**：打开网站，用你的密码登录（用户名任意），点左下角「设置」：填模型接口（格式、地址、API key，再点「列出可用模型」选一个模型），并把「X API 每月上限」的读取上限临时调到收藏数的 3 倍左右（默认 1500 只够导七八百条，导完清空）。保存时会先试连一次模型，填错了会直接提示。然后点「连接 X」并授权，再点「同步」。每次同步最多整理 600 条，显示「待整理」时再点一次「同步」继续。细节见「[导入已有收藏](#导入已有收藏)」。
6. **清理**：打开「待清理」，模型判为过期或垃圾的条目默认全选；取消勾选想留的，或点「保留」让它以后不再出现，然后点「移到回收站」，这些条目会同时从 X 收藏夹取消。回收站里点「恢复」会重新收藏到 X，确认无误后再「彻底删除」。细节见「[清理与回收站](#清理与回收站)」。

以 1000 条收藏为例：首次导入约 $1–3，清理 200 条约 $1（每条 $0.005），之后日常每月几毛钱。用 Docker 部署时第 3 步换成下方方式二或三，其余步骤相同；回调地址里的网站地址就是你在浏览器里打开它的地址。

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

1. 点上面的按钮，登录 Cloudflare。它会把仓库复制到你的 GitHub、自动创建 D1 数据库，并让你填写网站密码和 X 的 Client ID / Secret。
2. 部署完成后得到 `https://x-bookmark-manager.<你的子域>.workers.dev`，把 `这个地址/api/x/callback` 填回 X App 的 Callback URI。
3. 打开网站，用你设的密码登录（用户名任意），在左下角「设置」里填模型接口，再点「连接 X」。

也可以用命令行部署：

```bash
git clone https://github.com/sleepingF0x/x-bookmark-manager.git && cd x-bookmark-manager
npm install
npx wrangler login
npx wrangler d1 create x-bookmark-manager      # 把输出的 database_id 填进 wrangler.jsonc
npm run deploy                                 # 建表（D1 migrations）+ 部署
for s in SITE_PASSWORD X_CLIENT_ID X_CLIENT_SECRET; do npx wrangler secret put $s; done
```

模型接口和 X API 上限在网站的「设置」里改；网站密码和 X App 凭据在 Cloudflare 后台 Workers & Pages → x-bookmark-manager → Settings → Variables and Secrets。

#### 可选：改用 Cloudflare Access 登录

默认用浏览器弹窗输入网站密码。也可以换成 Cloudflare Access：打开网站时先进入 Cloudflare 托管的登录页（Cloudflare 账号、邮箱验证码或你配置的 Google / GitHub 等），不用再记网站密码，侧栏会出现「退出登录」。个人使用在 Zero Trust 免费版内（50 个用户以内免费）；第一次用要先在控制台开通 Zero Trust 并起一个团队名。

**1. 给 Worker 打开 Access**

Workers & Pages → x-bookmark-manager → **Access** 标签 → **Protect this Worker behind Access**：

- 范围选 **All traffic**（不要选 Previews only，否则正式地址不受保护，设了下面的变量后会一律 403）。
- Authentication policy 选 **Cloudflare account**：只有你这个 Cloudflare 账号的成员能登录，个人账号就是你自己，登录用的就是 Cloudflare 账号（含两步验证）。
- 会话时长默认 24 小时，可在 15 分钟到 1 个月之间调整。

> 不要选 Email domain 再填 `gmail.com`、`qq.com` 这类公共邮箱域名——那等于放行所有用这个邮箱服务的人。想按具体邮箱放行，建好后到 Zero Trust → Access controls → Policies 编辑这条策略，加 **Include → Emails → 你的邮箱**。

**2. 加两个变量**

Worker 的 Settings → Variables and Secrets，加两个普通变量（不是 secret，也不会被重新部署清掉）：

| 变量 | 填什么 | 在哪找 |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `https://<团队名>.cloudflareaccess.com`（只填团队名也行） | 开通 Zero Trust 时起的团队名 |
| `ACCESS_AUD` | 一长串十六进制 | Zero Trust → Access controls → Applications → 这个 Worker 的应用 → Edit → Additional settings → **Application Audience (AUD) Tag** |

**3. 确认**

用无痕窗口打开网站：应该只出现 Cloudflare 登录页、不再弹密码框，登录后侧栏底部有「退出登录」。

**说明**

- 设了这两个变量后，应用会逐个请求校验 Access 附带的签名令牌（`Cf-Access-Jwt-Assertion`：签名、团队域名、AUD、有效期），不再接受网站密码；即使请求绕过了 Access，没有有效令牌也进不来。
- 只设了其中一个时一律拒绝访问（500「配置不完整」），避免配置写错时悄悄退回密码登录。所以从旧版本升级时，**先把两个变量都加好，再部署新代码**。
- 应用只认「这是 Access 为本应用签发的有效令牌」，不再单独检查邮箱：谁能登录完全由第 1 步的策略决定。
- 要换回密码登录：删掉这两个变量（在控制台保存即生效，不用重新部署；`SITE_PASSWORD` 要还在），再在 Access 标签里关掉保护。
- 旧入口 Settings → Domains & Routes → `workers.dev` 一行的 **Enable Cloudflare Access** 也能用，但只保护 workers.dev 和预览地址；Access 标签会把这个 Worker 的所有地址（含自定义域名）一起保护。
- Docker 版放在 Cloudflare Tunnel + Access 后面时，也可以用同样两个变量。

### 方式二：Docker + 自己的服务器（自动 HTTPS）

需要一台开放了 80/443 端口的服务器，并把一个域名解析到它。

```bash
git clone https://github.com/sleepingF0x/x-bookmark-manager.git && cd x-bookmark-manager
cp .env.example .env     # 填 DOMAIN、密码、X、Cloudflare Workers AI；模型接口之后在网站「设置」里填
docker compose up -d
```

[Caddy](https://caddyserver.com) 自动申请并续期证书，网站地址就是 `https://<DOMAIN>`。数据在 `./storage/x-bookmarks.db`，备份复制这个目录即可。

### 方式三：Docker 在自己电脑上

```bash
cp .env.example .env     # 填密码、X、Cloudflare Workers AI；模型接口之后在网站「设置」里填
docker run -d --name x-bookmark-manager --restart unless-stopped \
  -p 127.0.0.1:8787:8787 --env-file .env -v "$PWD/storage:/data" \
  ghcr.io/sleepingf0x/x-bookmark-manager:latest
```

网站地址 `http://127.0.0.1:8787`（用这个地址打开，不要用 `localhost`），X App 的 Callback URI 填 `http://127.0.0.1:8787/api/x/callback`。不用 Docker 也行：Node.js 22.13+ 下 `npm start`（读取同样的环境变量）。

### 配置项

部署时需要的环境变量：

| 名字 | 说明 |
|---|---|
| `SITE_PASSWORD` | 网站密码（用户名任意）。未设置时一律拒绝访问；启用 Cloudflare Access 后不再使用 |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X App 的 OAuth 2.0 Client ID / Secret |
| `DOMAIN` | 仅 docker-compose：Caddy 申请证书的域名 |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | 仅 Docker：调用 Workers AI 生成搜索向量（`@cf/baai/bge-m3`，与 Cloudflare 版同一模型）。Token 需要 Workers AI 读权限 |

可选的环境变量：

| 名字 | 说明 |
|---|---|
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | 改用 [Cloudflare Access](#可选改用-cloudflare-access-登录) 登录：团队域名（`https://<团队名>.cloudflareaccess.com`，只填团队名也行）与应用的 AUD。两个都要设 |
| `PUBLIC_URL` | 仅 Docker：网站的公开地址，用来生成 X 回调地址。一般不用填：经过 Caddy 等反向代理时从 `X-Forwarded-Proto` / `Host` 推出来，本机就是你打开的地址；代理不转发这两个请求头时才需要 |
| `DB_PATH` / `PORT` | 仅 Docker / Node：数据库文件路径（镜像内默认 `/data/x-bookmarks.db`）与端口（默认 8787） |

**在网站「设置」里改的**（不用碰部署配置，改完立即生效）：

| 设置 | 说明 |
|---|---|
| 模型接口 | 格式（OpenAI / Anthropic 兼容）、地址、API key。OpenAI 兼容填到 `/v1`（如 `https://api.openai.com/v1`），Anthropic 兼容填根地址（如 `https://api.anthropic.com`）。「列出可用模型」读接口的模型列表 |
| 模型 | 模型名，如 `gpt-5-mini`、`deepseek-v4-pro`。保存模型或接口时会先试连一次，失败就不保存 |
| X API 每月上限 | 读取 / 写入，默认 1500 / 200 |

旧部署里的 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_FORMAT` 和 `X_MONTHLY_READ_CAP` / `X_MONTHLY_WRITE_CAP` 仍然有效，作为「设置」里没填时的值；「设置」里填了的优先，清空就改回这些变量。

### 连接 X 时的常见问题

- 授权页提示「你无法获得该应用的访问权限」：多半是 Callback URI 和网站地址不一致（`https`、末尾斜杠、域名拼写）。
- 授权页的「我信任此应用」勾不上：广告拦截或隐私类浏览器插件拦了 X 的脚本，临时关掉即可。授权只需一次，之后的同步都在服务端完成。

## 导入已有收藏

**方法 A：直接用网站同步（任何系统）**。数据库为空时，第一次同步会从最新往前把收藏一页页全部拉进来，再分批用你的模型整理。

- 首次导入前在「设置」里把读取上限临时调到收藏数的 3 倍左右（计数包含作者和被引用的帖子），否则默认的 1500 会在七八百条处停下；导完清空即可。
- 一次同步最多翻约 2700 条；收藏更多时，之后点一次「全量核对」补齐剩下的。
- 每次同步最多整理 600 条，剩下的显示为「待整理」，再点一次「同步」继续。
- 模型连续 3 轮都处理不了的条目（比如被模型接口的内容审核拦截）会放进「未分类」并标「模型未整理」，不再挡住后面的条目；接口本身不可用（key 错误、模型名不对、限流）时整理会停下，不会这样放弃。
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
- **在 X 上直接取消的收藏**：「全量核对」发现后，会问 X 这条帖子还在不在（每条只问一次，$0.001）。帖子还在，说明是你取消的，移到回收站；帖子已被删除、设为私密或作者被封，就留在知识库并标「原帖已删除或不可见」，因为这可能是仅存的一份。以前留在知识库里、标着「已不在 X 收藏」的条目，在下一次「全量核对」时按同样规则处理（只有完整核对过整个收藏列表，才能确定它真的不在了；其实还在收藏里的会改回已收藏）。
  X 的接口有时只返回最新的一部分收藏就结束、也不报错（实测 700 条里只给了约 200 条）。所以只对比它返回的最旧一条更新的条目判断取消；更早的条目没法核对，保持原样，同步结果会提示有多少条没法核对。在 X 上重新收藏的，下次同步会自动移出回收站。

API 不可用时的备用方案（Cloudflare 版）：`node scripts/unbookmark.mjs` 在你的 Chrome 里逐条点掉「在回收站但仍在 X 收藏中」的条目，完成后回写 D1。前 5 条是试运行，出现异常结果立即停止；`--dry-run` 只定位按钮、不点击。

## 费用

X API 是预充值、按量扣费，**不开 auto-recharge 就不会自动扣卡**。实测读取自己的收藏 $0.001/条；取消或恢复收藏 $0.005/次。

| 操作 | 大约花费 |
|---|---|
| 一次增量同步（读最新 10 条，碰到已收录的就停） | $0.01 |
| 一次全量核对（只读 id 列表） | 收藏数 × $0.001 |
| 核实在 X 上取消的收藏（每条一次） | 仍存在的帖子 × $0.001 |
| 移到回收站 / 恢复 | 每条 $0.005 |
| 日常使用（每月几十条新收藏） | 每月 $0.3 左右 |

Cloudflare（Workers、D1、Workers AI）在免费额度内；模型调用走你自己的接口。代码里的月度上限到了就拒绝调用 X API，和 X 后台的消费上限互相独立，建议两边都设。

## 架构

```
浏览器 (site/index.html)
   │  登录检查（src/auth.js，静态文件也在登录之后）：网站密码，或校验 Cloudflare Access 令牌
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
  app.js                     路由；auth.js 整站登录检查（密码 / Cloudflare Access）
  worker.js                  Cloudflare Workers 入口
  node.js                    Node / Docker 入口；node/d1.js、node/ai.js 是 D1 与 Workers AI 的替身
  api/items.js embed.js      整个库（含向量）/ 搜索词向量
  api/trash.js restore.js    回收站：移入（并从 X 取消收藏）/ 恢复（并重新收藏）
  api/purge.js keep.js       彻底删除 / 标记保留
  api/analyze.js             重新分析一批（清理判断）
  api/x/login.js callback.js X OAuth
  api/x/sync.js process.js   同步 / 为新条目分类 + 生成向量
  api/x/status.js llmcheck.js  连接与用量 / 模型诊断（?models=1 列模型，?compare=N 与现有标签对比）
  api/settings.js            「设置」面板：模型接口、模型、X API 上限（lib/settings.js 叠加在环境变量之上）
  lib/                       X API 客户端、条目转换、模型调用与提示词、存储与月度预算
migrations/                  数据库表结构（D1 migrations；Node 版启动时自动执行）
scripts/                     本地导入流水线；apply-sql.mjs 把 SQL 导入 Docker 版数据库
wrangler.jsonc  package.json Cloudflare 配置（database_id 是占位符，部署按钮会自动替换）
Dockerfile  docker-compose.yml  deploy/Caddyfile  .env.example   Docker 部署
.github/workflows/           CI（登录与核心流程测试、两个版本的冒烟测试）与镜像发布（ghcr.io）
```

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars        # 至少填 SITE_PASSWORD
npm run dev                           # Cloudflare 版：http://localhost:8787（本地 D1，Workers AI 走远程）
SITE_PASSWORD=dev npm start           # Node 版：http://localhost:8787（storage/x-bookmarks.db）
npm test                              # 登录、核心流程（X 与模型接口都是桩，不花钱）、冒烟测试
```

## 安全

- 网站密码和 X Client Secret 只放在 Cloudflare 加密 secret 或你自己的 `.env` 里，不写进代码或仓库。X 的 OAuth token 和「设置」里填的模型 key 存在你自己的数据库里；模型 key 只写不读，接口不会把它返回给页面（只显示末四位），换接口地址必须重新填 key，所以已保存的 key 不会被发往别的地址。
- 整站（包括静态文件和全部 API）都在登录检查之后：密码模式下 `SITE_PASSWORD` 未设置时一律返回 401；Cloudflare Access 模式下逐个请求校验 Access 令牌的签名、签发方（团队域名）、AUD 和有效期，校验失败返回 403。
- 拒绝其他网站发起的 API 请求（浏览器标记的 `Sec-Fetch-Site`），写操作只接受 `application/json`：别的网页没法借你已登录的浏览器去同步、清理或调用模型花钱。
- `data/`（本地流水线的个人数据）、`storage/`（Docker 版数据库）、`.env`、`.dev.vars` 都在 `.gitignore` 中。**数据库文件和导出包含 OAuth token，不要分享。**

## 已知限制

- 通过 API 同步进来的 X 长文章，正文结构是否完整未经验证；本地流水线抓取的是完整结构。
- 新同步的条目没有图片 OCR，分类和清理判断只看文字；提示词已要求模型不要仅因正文没写清就判为垃圾。
- 被删除或设为私密的推文仍会占着 X 收藏列表的位置，但拿不到内容，不会进入知识库。

## 许可

[MIT](LICENSE)
