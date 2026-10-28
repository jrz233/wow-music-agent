# 安全说明

WOW 音乐 Agent 的设计目标是：**平台令牌只存在于用户自己的 Cloudflare Worker 里**，
wow-server 只能读取白名单内的歌单、收藏、每日推荐与漫游数据，永远拿不到令牌、Cookie
或播放地址。

这份文档描述实际实现的防护、信任假设和仍然存在的风险。它不是第三方安全审计报告。

## 支持范围

当前维护 `0.1.x`。安全问题请针对最新版本报告。

## 信任模型

| 角色 | 信任程度 | 能看到什么 |
| --- | --- | --- |
| 用户本人 | 完全信任 | wow-server 账号、平台扫码、wow-server 面板 |
| Cloudflare | 基础设施信任 | Durable Object 存储（含 master key 与密文）、Worker 内存、日志 |
| wow-server 运营者 | 有限信任 | 语义化音乐数据、平台昵称/头像 URL/平台用户 id；**没有令牌** |
| QQ 音乐 / 网易云 | 外部服务 | 来自 Cloudflare 出口 IP 的只读请求；扫码登录会话 |
| 网络中间人 | 不信任 | 只看到 TLS 密文 |

假设 TLS 由 Cloudflare 终止；Agent 与 wow-server 之间必须走 HTTPS。

## 受保护资产

1. 平台会话 Cookie（QQ 音乐、网易云）。
2. Agent 的 Ed25519 私钥。
3. Durable Object 内的 master key。
4. 管理会话 token、CSRF token 与一次性 PKCE verifier。
5. 用户的歌单、收藏、推荐数据。

## 已实现的防护

### 1. 管理面

- **没有本地密码。** 管理页的登录就是用 wow-server 账号完成一次 OAuth 授权：
  wow-server 决定谁能登录，Agent 只负责发起与接收回跳。因此没有可被爆破的本地口令，
  也没有对应的锁定计数要维护。
- **会话**：256-bit 随机 token，SQLite 只存 SHA-256；Cookie 为
  `HttpOnly; SameSite=Lax; Path=/`，HTTPS 下自动加 `Secure`，12 小时过期。
  CSRF Cookie 故意不是 HttpOnly，用于双提交校验。
  `Lax` 而不是 `Strict` 是必要的：授权回跳是跨站顶层导航，`Strict` 会让紧随的
  `/admin` 请求带不上刚签发的会话。
- **每次授权成功都会删除其他设备上的旧会话**，重新登录一次即可立刻吊销旧浏览器；
  否则旧会话最多还能用到 12 小时过期。
- **写操作**必须同时满足：有效会话、`Origin`（缺失时退回 `Referer`）与自身同源、
  表单/请求头里的 CSRF token 哈希与会话记录一致。登录 POST 也要求同源。
- **CSP**：`default-src 'none'`，脚本与样式只允许单次请求的 nonce；无外部 CDN、
  无内联事件属性、无 `unsafe-inline`；`frame-ancestors 'none'`、`base-uri 'none'`。
  所有 `/admin/*` 与 `/v1/*` 响应都是 `Cache-Control: no-store`。
- **二维码不出站**：二维码由 Worker 服务端抓取，以 `data:image/png;base64` 内联，
  页面不会把用户 IP 暴露给平台图片域名；头像只显示昵称首字，不加载平台 CDN。
- 所有动态 HTML 文本经 HTML 转义；平台错误信息先脱敏、截断再展示。

### 2. 绑定（OAuth 授权码 + PKCE）

- 授权是标准的 OAuth 授权码流程，wow-server 是身份提供方：用户在 wow-server 页面上
  用**自己的站点账号**确认，Agent 从不接触该账号的密码或会话。
- Agent 每轮生成 256-bit 的 `state` 与 PKCE verifier（S256），10 分钟过期。
  verifier 用 master key 加密落库（AAD/salt `oauth-pkce`），从不进入浏览器 URL。
- 回跳必须同时满足：`state` 常量时间相等、回调 origin 与登记值一致、授权码格式正确。
  不匹配的回跳一律拒绝，且不区分是哪一项失败。
- 授权码由 wow-server 一次性消费，2 分钟过期，数据库只存哈希；换取时绑定
  `redirect_uri` 与 PKCE verifier。
- **绑定不是自动发生的**：首次授权页会展示 Agent 名称、endpoint host 与公钥指纹
  （SHA-256 前 16 字节的十六进制），必须由用户显式点击允许。只有「同一账号 + 同一
  地址 + 同一公钥」再次登录才自动通过。
- 双方各自生成 Ed25519 密钥对；私钥用 master key 密封后落库。
- Agent 对用户填写的 wow-server 地址只接受 `https://host[:port]`，禁止路径、query、
  userinfo 和锚点；`localhost` 的 http 仅用于本地开发。出站请求不跟随重定向，避免把
  授权码带到第三方 origin，超时 15 秒，响应体上限 64 KiB。
- 授权成功后用同源中转页（`meta refresh`）跳去 wow-server：CSP 的 `form-action 'self'`
  会拦截表单提交后的跨站 303，中转页不受该指令约束，同时保持 `Referrer-Policy:
  same-origin`。（不能写 `no-referrer`：那种策略下浏览器会把同源表单 POST 的
  `Origin` 也降成 `null`，同源校验就永远拿不到可信来源。）

### 3. Agent 接口（wow-server → Agent）

- 只有白名单内的 `/v1/*` 路径；所有路径都是只读 `GET`。
- 每个请求都必须带 wow-server 的 Ed25519 签名，canonical string 覆盖：
  `WOW-AGENT-REQUEST-V1`、method、path、归一化 query、Unix 时间戳、128-bit nonce、
  body 的 SHA-256。
- 时间窗 ±60 秒；nonce 写入 Durable Object 的唯一索引，时间窗内重复即拒绝。
- 未配对、agentId 不匹配、公钥解析失败、签名错误一律返回同一个 401，不解释细节。
- 响应也签名（`WOW-AGENT-RESPONSE-V1` + 状态码 + body 哈希 + 请求 nonce）。
  wow-server 验签失败即视为 Agent 不可用，不采信响应内容。
- 请求体上限 64 KiB；`limit` 上限 200；未知路径 404。
- 没有 cookie、没有 CORS 通配、没有把 Agent 暴露成通用代理的接口。

### 4. 平台令牌

- master key 为 32 字节随机数，首次启动时生成并保存在 Durable Object SQLite。
- 平台凭据使用 HKDF-SHA256（salt = AAD = `platform/<platform>/<userId>`，
  info = `wow-agent-storage-v1`）派生 AES-256-GCM 密钥，96-bit 随机 IV，
  密文格式 `v1:<iv>:<ciphertext>`。AAD 防止把 A 账号的密文挪到 B 账号下解密。
- Agent 的 Ed25519 私钥同样用 AES-256-GCM 密封，AAD/salt 为 `agent-key`。
- `/v1/*` 的响应只包含 `shared/types.ts` 定义的语义字段：id、标题、艺人、专辑、
  封面 URL、时长、曲序等。**不存在** token、cookie、播放地址、歌词或任意平台 URL
  透传。
- 平台错误在写入 `last_error` 和日志前经过 `redact()`：Cookie、Authorization、
  token、password、secret、signature、JWT 等键值会被替换，控制字符被移除，最长 500 字符。
- 平台刷新失败只降级为 `degraded`；只有平台明确拒绝会话时才清除密文并标记
  `logged_out`。网络错误不会被误判为退出登录。

### 5. 刷新与后台任务

- 平台会话在到期前 10 分钟刷新，至少每 30 分钟探活一次；失败后 15 分钟再试。
- 刷新由 Durable Object alarm 驱动。Workers Cron 只是兜底，通过 **Durable Object RPC**
  调用维护方法；**没有**可通过 HTTP 触发的内部 cron 路径。
- 管理页登录/退出平台后会立即重排 alarm。
- 公开路由只有 `/healthz`（只返回名称与版本）以及需要鉴权的 `/admin*`、`/v1/*`。

### 6. 依赖与构建

- 运行时依赖只有 `hono`；没有第三方前端脚本、字体或 CDN。
- `package-lock.json` 固定依赖树；CI 执行 `npm ci`、类型检查与全部测试。
- 生产构建由 Wrangler 打包；`npm run deploy` 不会上传 `.dev.vars`（已在
  `.gitignore` 中）。

## 不防护 / 残余风险

1. **Cloudflare 账号被接管 = 完全失守。** Durable Object 存储中包含 master key 和
   密文，拥有该 Worker/账号访问权限的人可以读取两者。请为 Cloudflare 账号开启 2FA，
   不要共用账号，限制成员权限。
2. **Cloudflare 平台本身**可以看到 Worker 内存中的明文令牌与 DO 存储。这是自托管在
   第三方 Serverless 上的固有取舍；如果你不能接受，请改为部署在自己的机器上。
3. **wow-server 会看到语义数据**：平台昵称、平台用户 id、头像 URL、歌单/收藏/推荐
   内容与更新时间。按设计它拿不到令牌，也不能要求 Agent 执行任意平台操作。若
   wow-server 不可信，不要配对。
4. **平台侧风险**：QQ 音乐与网易云的接口不是公开 API，可能变更、限流或触发风控；
   使用本 Agent 可能不符合平台服务条款，风险由用户自行承担。Agent 只读、低频，
   但无法保证账号不被限制。
5. **出口 IP 共享**：请求从 Cloudflare 出口发出，可能与其它用户共享 IP；平台可能
   因此提高风控等级。
6. **管理面的强度等于 wow-server 账号的强度。** Agent 自己没有第二因素；拿到
   wow-server 会话的人可以授权一台自己的 Agent，也可以撤销现有绑定。建议给
   wow-server 账号开启它支持的全部登录保护，并在 Cloudflare Access 后额外加一层。
7. **没有第三方安全审计。** 私有 API 的解析逻辑与平台实现可能包含未知缺陷。
8. **可用性**：单例 Durable Object，没有多副本故障转移；Cloudflare 故障时 Agent
   不可用。wow-server 会在平台不可用时回退本地数据。
9. **浏览器扩展 / 已被攻陷的终端**可以读取非 HttpOnly 的 CSRF Cookie 并发起请求；
   但拿不到 HttpOnly 的会话 Cookie。终端被攻陷时，任何 Web 管理面都无法自保。
10. **删除 Worker 不一定立即抹除 DO 存储**；如需彻底清除，请在 Cloudflare 控制台
    确认 Durable Object 数据已删除。

## 部署建议

- 为 Cloudflare 账号开启 2FA；仅授予必要的 Worker / Durable Object 权限。
- 建议 Workers Paid，避免免费版 10ms CPU 限制导致扫码或刷新超时（这不只是性能问题，
  超时也会增加重试与风控暴露）。
- 定期执行 `npm audit` 并更新 `hono` / `wrangler`；更新后跑 `npm test`。
- 不使用时：在管理页退出平台登录，或在 wow-server 面板解除绑定。
- 怀疑泄露时：在 wow-server 解除绑定（旧 agentId 立即失效）→ 在两个平台退出登录 →
  重新扫码 → 重新完成一次 OAuth 授权（会生成新的 Ed25519 密钥对）。
- 不要把 `.dev.vars`、`.wrangler/`（本地 DO 数据）或任何导出的 DO 数据提交到公开仓库。

## 报告漏洞

请通过仓库的 **Security → Report a vulnerability**（GitHub Security Advisories）私下报告，
不要先开公开 issue。请包含：影响版本、复现步骤、影响范围，以及是否涉及令牌泄露。
维护者会尽力在 72 小时内确认，并在修复发布后致谢（如果你愿意署名）。

请勿在报告中附带真实平台 Cookie、token 或他人数据；用你自己测试账号的最小复现即可。
