# WOW 音乐 Agent

自托管的 **QQ 音乐 / 网易云音乐** 账号 Agent，运行在 Cloudflare Workers 上，为
[wow-server](https://github.com/jrz233/wow-server) 提供**只读**的歌单、收藏、每日推荐与漫游数据。

平台账号只登录在你自己的 Agent 里，令牌不会离开你部署的 Worker：

```
wow-server ── 双向 Ed25519 签名 ──▶ 你的 Agent ──▶ QQ 音乐 / 网易云
   ▲                                   │
   └──────── 用户名、歌单、推荐 ◀───────┘
             （没有令牌字段）
```

- **零配置**：不需要任何 secret。管理页用你的 wow-server 账号 OAuth 登录，存储密钥、会话与签名私钥在 Durable Object 内自动生成。
- **只读**：不解析播放地址、不收藏、不改歌单。
- **单用户**：一次部署服务一个 wow-server 账号；重新授权即替换。
- **零前端依赖**：管理页服务端渲染，二维码内联，CSP 默认 `default-src 'none'`。

---

## 部署

### 方式一：Deploy to Cloudflare 按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jrz233/wow-music-agent)

不需要设置任何 secret 或环境变量：打开部署出来的地址即可开始。

### 方式二：命令行

需要 Node.js 20+ 与 Cloudflare 账号。

```bash
git clone https://github.com/jrz233/wow-music-agent.git
cd wow-music-agent
npm ci

npx wrangler login
npx wrangler deploy
```

部署输出会给出 `https://wow-music-agent.<你的子域>.workers.dev`。直接打开这个地址就是
管理页（`/` 会跳到 `/admin`，不需要手打路径）。

> **建议 Workers Paid。** 免费版每次请求只有 10ms CPU，扫码轮询与 weapi 加密可能超时；
> 免费版仍能运行，但失败率更高。Durable Object 需要 SQLite-backed class（配置已包含）。

### 可选：自定义域名

在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Domains & Routes 绑定。
wow-server 只接受 **https + 443 + 根路径** 的 Agent 地址，自定义域名更容易通过校验。

---

## 使用

### 1. 连接 wow-server

1. 打开 `https://<worker>/`，填入你的 wow-server 地址（只填到域名，例如
   `https://music.example.com`），点 **登录**。
2. 浏览器跳到 wow-server 的授权页。用**你已有的本站账号**登录（没登录会先跳登录页）。
3. 核对页面上显示的 Agent 地址与公钥指纹，点 **允许授权**。
4. 自动回到 Agent，显示「已连接」。

这是一条标准的 OAuth 授权码 + PKCE 流程，Agent 不接触你的 wow-server 密码，
也不需要你复制任何配对码。同一台 Agent 再次登录时，wow-server 会自动通过（账号、
地址、公钥三者都匹配），不再要求确认。

若提示「Agent 地址不可用」，通常是：不是 https、带了路径、DNS 不是公网地址，
或 wow-server 未配置 `PUBLIC_BASE_URL`。

### 2. 登录平台账号

1. 在管理页点击 **QQ 音乐 → 扫码登录**，用 QQ 音乐 App 扫码。
2. 点击 **网易云音乐 → 扫码登录**，用网易云音乐 App 扫码。

两个平台可以只登录一个。二维码由 Agent 服务端抓取后内联，页面不会加载平台图片域。

### 3. 在 wow-server 里使用

- `/v1/user/playlist/list` 会合并两个平台的歌单，并用 `QQ` / `网易云` 标签区分。
- 面板可设置每日推荐与漫游来源：本地 / QQ / 网易云；所选平台失败时自动回退本地。
- QQ 漫游可切换 **雷达**（radar）与 **猜你喜欢**（radio）。
- 平台歌单是只读的：不能改名、删除或拖动。

### 4. 维护

- 会话在到期前 10 分钟自动刷新，至少每 30 分钟探活一次。
- 管理页会显示每个平台的最近刷新时间与预计到期时间。
- 「退出登录」立即删除该平台的加密凭据并取消下一次刷新。
- 「解除绑定」让 wow-server 立即失去访问；平台登录保留。
- 每次完成 OAuth 都会注销其他设备上的旧会话：重新登录一次即可让旧浏览器立刻掉线
  （否则旧会话最多还能用到 12 小时过期）。

---

## 同步上游更新

wow-server 会拿**上游仓库的最新提交号**和你部署的这份比：不一样就在用户中心每一页
顶部挂一条黄色提醒，让你把上游同步进自己的仓库。

Agent 在**构建时**把当前提交号盖进产物（`scripts/stamp-commit.mjs` →
`src/generated/commit.ts`），运行时由 `/v1/status` 的 `agentCommit` 与 OAuth 授权页的
`agent_commit` 上报。

同步的做法：

```bash
git remote add upstream https://github.com/jrz233/wow-music-agent.git
git fetch upstream
git merge --ff-only upstream/main
npx wrangler deploy
```

`git merge --ff-only` 会把你的 HEAD 推到上游最新的那个提交号上，两边相等，提醒消失。

两个容易踩的坑：

- **不要提交 `src/generated/`。** 它已经被 `.gitignore` 忽略：提交它会让你的仓库变脏，
  `git pull` 会被 git 拦下来——正好破坏上面这套流程。盖章在 `npm install`、npm 的
  `predeploy` 钩子和 `wrangler.toml` 的 `[build]` 里各做一次，所以
  `npx wrangler deploy` 这种绕过 npm 的部署也会重新盖章。
- **不要在镜像仓库里直接改代码。** 它是从 wow-server 的 `agent/` subtree split 出去的
  发布镜像，下一次同步会覆盖掉。

---

## 本地开发

```bash
npm ci
npm run dev        # http://localhost:8787/
```

本地完全不需要 `.dev.vars`。

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir dist
```

> `wrangler dev` 的本地地址是 `http://localhost`，而 wow-server 的 SSRF 校验只接受
> 公网 https 的回调地址，因此本地调试通常只验证扫码与管理页；完整授权请部署到
> workers.dev 或使用隧道。

---

## 对外能力（wow-server 调用）

所有路径都是 `GET`，请求与响应都带 Ed25519 签名；详细规范见
[wow-server 文档](https://github.com/jrz233/wow-server/blob/main/docs/agent.md)。

| 路径 | 说明 |
| --- | --- |
| `/v1/status` | Agent 版本、源码提交号、能力列表与两个平台的登录状态 |
| `/v1/library/playlists?platform=qq\|netease&limit=` | 用户歌单 |
| `/v1/library/playlists/:id/tracks?platform=&limit=` | 歌单曲目 |
| `/v1/library/favorites/tracks?platform=&limit=` | 收藏（「我喜欢的音乐」） |
| `/v1/library/snapshot?platform=all\|qq\|netease&limit=&trackLimit=&ids=` | 歌单批量快照（列表 + 收藏 + 详情） |
| `/v1/recommend/daily?platform=&limit=` | 每日推荐 |
| `/v1/recommend/roam?platform=&mode=radar\|radio&limit=` | 漫游；`mode` 仅 QQ 有效 |

统一响应 `{items, hasMore, nextOffset}`，歌单详情为 `{playlist}`。列表类 `limit` 上限 200；
歌单详情的 `limit` 按曲目计，上限 1000，超过一页时 Agent 自行翻页取全。
快照接口返回 `{platforms:{qq:{playlists,favorites,details,error}, netease:{...}}}`，
`ids` 最多 20 个，用于只补齐指定歌单的详情。
**不会返回**：平台 Cookie / token、播放地址、歌词、平台隐私字段或任意 URL。

---

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 登录页提示地址不可用 | 必须 https、443、公网 DNS、只填域名；确认 wow-server 已配置 `PUBLIC_BASE_URL` |
| 授权后回到登录页 | state 已过期（超过 10 分钟）或被拒绝；重新点登录即可 |
| 授权页提示「Agent 已被其他账号绑定」 | 这台 Agent 已归属另一个 wow-server 账号；先在原账号解绑 |
| Agent 显示离线 | wow-server 出站被 SSRF 规则拦截，或 Agent 域名不可达 |
| 平台显示「登录已失效」 | 重新扫码；平台风控或改密都会让旧 Cookie 失效 |
| 平台显示「降级」 | 网络抖动，Agent 会在 15 分钟后重试；可手动重新扫码 |
| QQ 漫游为空 | 某些账号的雷达/猜你喜欢需要先在客户端使用过；换另一个模式试试 |
| 免费版偶发超时 | 升级 Workers Paid，或减少同时在线的 wow-server 请求 |

日志默认开启 observability；日志里不应出现 Cookie / token / 签名。若发现泄露，请按
[SECURITY.md](./SECURITY.md) 报告。

---

## 目录

```
src/
  index.ts          # Worker 入口：/healthz，其余转给 DO
  env.ts            # 常量（没有任何 secret）
  commit.ts         # 构建时盖上的源码提交号（供 wow-server 判断版本新旧）
  agent/
    do.ts           # 单例 Durable Object、alarm、cron
    store.ts        # SQLite schema 与读写（密文列）
    crypto.ts       # HKDF + AES-256-GCM
    signing.ts      # Ed25519、canonical string、nonce
    oauth.ts        # 生成密钥、OAuth 授权与回跳、解除
    refresh.ts      # 刷新调度与状态机
    v1.ts           # wow-server 只读接口（验签 + 响应签名）
    redact.ts       # 日志脱敏
  admin/            # OAuth 登录、会话与 CSRF、CSP、服务端渲染管理页
  qq/               # 扫码、musicu.fcg、歌单/每日/雷达/猜你喜欢
  netease/          # 扫码、weapi、歌单/每日/Personal FM
test/               # Vitest：共享签名向量、加密、映射、v1 签名
```

## 许可证

[MIT](./LICENSE)
