# WOW 音乐 Agent

自托管的 **QQ 音乐 / 网易云音乐** 账号 Agent，运行在 Cloudflare Workers 上。
平台账号只登录在你自己的 Worker 里，令牌不会离开你的部署。

```
wow-server ── Ed25519 签名 ──▶ 你的 Agent ──▶ QQ 音乐 / 网易云
   ▲                             │
   └──── 歌单、收藏、推荐 ◀───────┘
          （没有令牌字段）
```

- **零配置**：不需要任何 secret。管理页用你的 wow-server 账号 OAuth 登录，存储密钥、
  会话与签名私钥在 Durable Object 内自动生成。
- **只读**：不解析播放地址、不收藏、不改歌单。
- **单用户**：一次部署服务一个 wow-server 账号；重新授权即替换。
- **零前端依赖**：管理页服务端渲染，二维码内联，CSP 默认 `default-src 'none'`。

---

## 部署

### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jrz233/wow-music-agent)

不需要设置任何 secret 或环境变量：打开部署出来的地址即可开始。

### 命令行

需要 Node.js 20+ 与 Cloudflare 账号。

```bash
git clone https://github.com/jrz233/wow-music-agent.git
cd wow-music-agent
npm ci

npx wrangler login
npx wrangler deploy
```

部署输出会给出 `https://wow-music-agent.<你的子域>.workers.dev`，直接打开就是管理页。

> **建议 Workers Paid。** 免费版每次请求只有 10ms CPU，扫码轮询与 weapi 加密可能超时；
> 免费版仍能运行，但失败率更高。Durable Object 需要 SQLite-backed class（配置已包含）。

### 自定义域名

在 Cloudflare Dashboard → Workers → 你的 Worker → Settings → Domains & Routes 绑定。
wow-server 只接受 **https + 443 + 根路径** 的 Agent 地址，自定义域名更容易通过校验。

---

## 使用

### 1. 连接 wow-server

管理页只填 wow-server 地址（填到域名），点「登录」后跳到 wow-server 的授权页，
用你已有的站点账号确认授权，再自动回到 Agent。

这是标准的 OAuth 授权码 + PKCE：Agent 不接触你的 wow-server 密码，也不需要复制配对码。
同一台 Agent 再次登录时，账号、地址、公钥三者都匹配，wow-server 会自动放行。

地址必须满足 https、443、公网 DNS、只填到域名，且 wow-server 已配置
`PUBLIC_BASE_URL`，否则会提示「Agent 地址不可用」。

### 2. 登录平台账号

- **QQ 音乐**：用 QQ 音乐 App 扫「QQ 音乐 App 扫码」的二维码；App 里登录的是 QQ 账号
  还是微信账号都可以。二维码由 QQ 音乐自己的登录接口直接下发，不需要去开放平台申请
  AppID / AppSecret。
- **网易云音乐**：用网易云音乐 App 扫「网易云音乐 → 扫码登录」的二维码。

两个平台可以只登录一个。二维码由 Agent 服务端抓取后内联，页面不会加载平台图片域。

### 3. 维护

- 会话在到期前 10 分钟自动刷新，至少每 30 分钟探活一次。
- 管理页会显示每个平台的最近刷新时间与预计到期时间。
- 「退出登录」立即删除该平台的加密凭据并取消下一次刷新。
- 「解除绑定」让 wow-server 立即失去访问；平台登录保留。
- 每次完成 OAuth 授权都会注销其他设备上的旧会话：重新登录一次即可让旧浏览器立刻
  掉线（否则旧会话最多还能用到 12 小时过期）。

---

## 对外能力

所有路径都是 `GET`，请求与响应都带 Ed25519 签名。

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
歌单详情的 `limit` 按曲目计，上限 1000，超过一页时 Agent 自行翻页取全。快照接口返回
`{platforms:{qq:{playlists,favorites,details,error}, netease:{...}}}`，`ids` 最多 20 个，
用于只补齐指定歌单的详情。

**不会返回**：平台 Cookie / token、播放地址、歌词、平台隐私字段或任意 URL。

服务端如何调用这些接口、签名如何校验，见
[wow-server 文档](https://github.com/jrz233/wow-server/blob/main/docs/agent.md)。

---

## 更新到最新版

镜像仓库的内容始终是最新版的 Agent 源码，每次发布一个提交。更新：

```bash
git remote add upstream https://github.com/jrz233/wow-music-agent.git  # 已有则跳过
git fetch upstream
git reset --hard upstream/main

npm ci
npx wrangler deploy
```

部署后 Agent 会自报新的源码提交号，wow-server 据此判断你部署的还是不是旧版。

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

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 登录页提示地址不可用 | 必须 https、443、公网 DNS、只填域名；确认 wow-server 已配置 `PUBLIC_BASE_URL` |
| 授权后回到登录页 | state 已过期（超过 10 分钟）或被拒绝；重新点登录即可 |
| 授权页提示「Agent 已被其他账号绑定」 | 这台 Agent 已归属另一个 wow-server 账号；先在原账号解绑 |
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
  commit.ts         # 构建时盖上的源码提交号
  agent/            # Durable Object、加密、签名、OAuth、刷新与 /v1 接口
  admin/            # 管理页：OAuth 登录、会话、CSRF、CSP、服务端渲染
  qq/               # QQ 音乐：扫码、musicu.fcg、歌单/每日/雷达/猜你喜欢
  netease/          # 网易云：扫码、weapi/eapi、歌单/每日/Personal FM
test/               # Vitest：共享签名向量、加密、映射、v1 签名
```

## 许可证

[MIT](./LICENSE)
