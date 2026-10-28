/**
 * 管理页模板（服务端渲染 + nonce CSP）。
 *
 * 不引任何第三方前端资源；二维码以 `data:` 内联；头像只显示首字，避免把用户 IP
 * 暴露给平台 CDN。所有动态文本都经过 `escapeHtml`。
 */

export interface PlatformView {
  platform: "qq" | "netease";
  loggedIn: boolean;
  status: string;
  accountId: string;
  nickname: string;
  avatarUrl: string;
  expiresAt: number;
  lastRefreshAt: number;
  lastError: string;
}

export interface PairedView {
  paired: boolean;
  agentId: string;
  fingerprint: string;
  accountName: string;
  serverHost: string;
  pairedAt: number;
}


const PLATFORM_LABEL: Record<"qq" | "netease", string> = {
  qq: "QQ 音乐",
  netease: "网易云音乐",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * 登录页：只填 wow-server 地址。
 *
 * 没有本地密码——点「登录」会跳去 wow-server，用你已有的本站账号确认授权，再回到这里。
 * `serverUrl` 是上次用过的地址，仅用于预填。
 */
export function loginPage(nonce: string, message: string, serverUrl: string): string {
  const error = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "";
  return layout(
    "登录",
    nonce,
    `<main class="narrow">
      <div class="brand"><span class="logo">♪</span><div><h1>WOW 音乐 Agent</h1>
      <p class="muted">QQ 音乐 / 网易云账号自持接入</p></div></div>
      <form method="post" action="/admin/login" class="card">
        <label>wow-server 地址
          <input name="serverUrl" type="url" value="${escapeHtml(serverUrl)}"
                 placeholder="https://music.example.com" required autocomplete="url"
                 inputmode="url" autofocus>
        </label>
        <button type="submit" class="primary">登录</button>
        ${error}
      </form>
      <p class="muted small">登录会跳转到你的 wow-server，用本站账号确认授权后自动返回。
      本 Agent 不保存任何平台账号或密码。</p>
    </main>`,
  );
}

/**
 * 表单提交后的中转页。
 *
 * 不能直接 303 到 wow-server：CSP 的 `form-action 'self'` 会连表单提交后的重定向
 * 一起校验，Chrome 会拦掉跨站跳转。这里返回同源页面，用 meta refresh 离开——它不受
 * `form-action` 约束；`Referrer-Policy: same-origin`（见 `routes.ts` 的 `html()`）
 * 保证跨站跳转不带 `Referer`，地址里的 state 不外泄。
 */
export function oauthRedirectPage(nonce: string, authorizeUrl: string): string {
  const url = escapeHtml(authorizeUrl);
  return layout(
    "前往授权",
    nonce,
    `<main class="narrow">
      <div class="card center">
        <h2>正在前往 wow-server…</h2>
        <p class="muted">请在新页面登录并确认授权，完成后会自动回到本 Agent。</p>
        <p><a class="button primary" href="${url}">如果没有自动跳转，点这里</a></p>
      </div>
    </main>
    <meta http-equiv="refresh" content="0;url=${url}">`,
  );
}

export function dashboardPage(options: {
  nonce: string;
  csrf: string;
  platforms: PlatformView[];
  paired: PairedView;
  message: string;
}): string {
  const { nonce, csrf, platforms, paired, message } = options;
  const cards = platforms.map((platform) => platformCard(platform, csrf)).join("");
  const banner = message ? `<p class="notice">${escapeHtml(message)}</p>` : "";

  const pairBox = paired.paired
    ? `<div class="card">
        <div class="row"><h2>已连接 wow-server</h2><span class="pill ok">已连接</span></div>
        <dl>
          <dt>账号</dt><dd>${escapeHtml(paired.accountName || "（未命名）")}</dd>
          <dt>服务端</dt><dd>${escapeHtml(paired.serverHost)}</dd>
          <dt>公钥指纹</dt><dd><code>${escapeHtml(paired.fingerprint)}</code></dd>
          <dt>连接时间</dt><dd>${formatTime(paired.pairedAt)}</dd>
        </dl>
        <form method="post" action="/admin/unpair" class="inline">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
          <button type="submit" class="danger">解除绑定</button>
        </form>
        <p class="muted small">解除后 wow-server 将立即失去对本 Agent 的访问；平台登录不受影响。</p>
      </div>`
    : `<div class="card">
        <div class="row"><h2>连接 wow-server</h2><span class="pill">未连接</span></div>
        <p>填入你的 wow-server 地址，用本站账号确认授权即可。</p>
        ${authorizeForm(csrf, "")}
      </div>`;

  return layout(
    "概览",
    nonce,
    `${chrome("概览", csrf, true)}
    <main>
      ${banner}
      <div class="grid">${cards}</div>
      ${pairBox}
      <div class="card muted-card">
        <h2>关于</h2>
        <p>平台令牌只保存在本 Agent 的 Durable Object 中，并使用 AES-256-GCM 加密。wow-server
        只能读取歌单、收藏、每日推荐与漫游，永远拿不到令牌。</p>
      </div>
    </main>`,
  );
}

export function qrPage(options: {
  nonce: string;
  csrf: string;
  platform: "qq" | "netease";
  imageDataUrl: string;
  nickname: string;
}): string {
  const { nonce, csrf, platform, imageDataUrl, nickname } = options;
  const label = PLATFORM_LABEL[platform];
  const title = nickname ? `${label}：${nickname}` : `登录 ${label}`;
  const script = `
    const status = document.getElementById('status');
    const hint = document.getElementById('hint');
    const qr = document.getElementById('qr');
    let stopped = false;
    async function poll() {
      if (stopped) return;
      try {
        const response = await fetch('/admin/api/${platform}/status', { cache: 'no-store' });
        const data = await response.json();
        if (data.state === 'success') {
          stopped = true;
          status.textContent = '登录成功，正在返回…';
          if (qr) qr.classList.add('done');
          setTimeout(() => { location.href = '/admin'; }, 600);
          return;
        }
        if (data.state === 'scanned') { status.textContent = '已扫码，请在手机上确认'; }
        else if (data.state === 'expired') {
          stopped = true;
          status.textContent = '二维码已过期';
          hint.innerHTML = '<a class="button" href="/admin/${platform}">刷新二维码</a>';
          if (qr) qr.classList.add('expired');
          return;
        } else if (data.state === 'error') {
          // 失败原因必须显示出来：以前一律显示「等待扫码」，扫码成功却换票失败时
          // 用户只看到「等待扫码」，完全不知道卡在哪一步。
          stopped = true;
          status.textContent = data.message || '登录失败，请重试';
          hint.innerHTML = '<a class="button" href="/admin/${platform}">重新获取二维码</a>';
          return;
        } else { status.textContent = '等待扫码…'; }
      } catch (error) {
        status.textContent = '网络异常，稍后重试…';
      }
      setTimeout(poll, 2000);
    }
    setTimeout(poll, 800);
  `;
  return layout(
    title,
    nonce,
    `${chrome("登录", csrf, true)}
    <main class="narrow">
      <div class="card center">
        <div class="row"><h2>登录 ${escapeHtml(label)}</h2><span class="pill">扫码</span></div>
        <p class="muted">使用 ${escapeHtml(label)} App 扫描二维码。</p>
        <img id="qr" class="qr" src="${escapeHtml(imageDataUrl)}" alt="${escapeHtml(label)} 登录二维码">
        <p id="status" class="status">等待扫码…</p>
        <p id="hint" class="muted small"></p>
        <p class="muted small">二维码由本 Agent 服务端抓取，不会把图片域名加入页面 CSP。</p>
      </div>
      <a class="back" href="/admin">← 返回概览</a>
    </main>
    <script nonce="${nonce}">${script}</script>`,
  );
}

/**
 * 已登录后的「连接 wow-server」表单。
 *
 * 与登录页的同名输入相比，这里带 CSRF 并走会话校验；提交后同样落到中转页。
 */
function authorizeForm(csrf: string, serverUrl: string): string {
  return `<form method="post" action="/admin/connect">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
    <label>wow-server 地址
      <input name="serverUrl" type="url" value="${escapeHtml(serverUrl)}"
             placeholder="https://music.example.com" required autocomplete="url" inputmode="url">
    </label>
    <label>Agent 名称（可选）
      <input name="agentName" type="text" maxlength="64" placeholder="我的音乐 Agent">
    </label>
    <button type="submit" class="primary">登录 wow-server</button>
  </form>`;
}

function platformCard(platform: PlatformView, csrf: string): string {
  const label = PLATFORM_LABEL[platform.platform];
  const badge = platform.loggedIn
    ? `<span class="pill ok">在线</span>`
    : platform.status === "degraded"
      ? `<span class="pill warn">降级</span>`
      : `<span class="pill">未登录</span>`;
  const detail = platform.loggedIn
    ? `<dl>
        <dt>账号</dt><dd>${escapeHtml(platform.nickname || platform.accountId || "—")}</dd>
        <dt>最近刷新</dt><dd>${platform.lastRefreshAt ? formatTime(platform.lastRefreshAt) : "—"}</dd>
        <dt>预计到期</dt><dd>${platform.expiresAt ? formatTime(platform.expiresAt) : "—"}</dd>
      </dl>
      <form method="post" action="/admin/api/platform/${platform.platform}/logout" class="inline">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
        <button type="submit" class="secondary">退出登录</button>
      </form>`
    : `<p class="muted">扫码后即可读取该平台的歌单、收藏、每日推荐与漫游。</p>
      <a class="button primary" href="/admin/${platform.platform}">扫码登录</a>`;
  const error = platform.lastError
    ? `<p class="error small">${escapeHtml(platform.lastError)}</p>`
    : "";
  return `<div class="card">
    <div class="row"><h2>${escapeHtml(label)}</h2>${badge}</div>
    ${detail}
    ${error}
  </div>`;
}

function chrome(active: string, csrf: string, authenticated: boolean): string {
  const navigation = authenticated
    ? `<nav>
        <a href="/admin" class="${active === "概览" ? "active" : ""}">概览</a>
        <a href="/admin/qq" class="${active === "QQ 音乐" ? "active" : ""}">QQ 音乐</a>
        <a href="/admin/netease" class="${active === "网易云音乐" ? "active" : ""}">网易云音乐</a>
      </nav>
      <form method="post" action="/admin/logout" class="logout">
        <input type="hidden" name="_csrf" value="${csrf}">
        <button type="submit" class="link">退出</button>
      </form>`
    : "";
  return `<header>
    <div class="brand"><span class="logo">♪</span><div><strong>WOW 音乐 Agent</strong>
      <span class="muted small">QQ 音乐 / 网易云</span></div></div>
    ${navigation}
  </header>`;
}

function layout(title: string, nonce: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · WOW 音乐 Agent</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function formatTime(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f4; --fg: #17181a; --muted: #6b6f76; --card: #ffffff;
  --line: #e4e4e1; --accent: #17181a; --accent-fg: #ffffff;
  --ok: #0f7b4f; --ok-bg: #e6f5ee; --warn: #8a5a00; --warn-bg: #fdf2dd; --danger: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #111214; --fg: #f2f2f0; --muted: #9ea3aa; --card: #1a1c1f;
    --line: #2a2d31; --accent: #f2f2f0; --accent-fg: #111214;
    --ok: #6ee7b7; --ok-bg: #0d2a20; --warn: #f5c26b; --warn-bg: #2a2113; --danger: #ff8a80; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; }
a { color: inherit; }
header { display: flex; align-items: center; gap: 24px; padding: 14px 24px;
  background: var(--card); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header .brand { display: flex; align-items: center; gap: 10px; }
header .brand strong { display: block; font-size: 15px; }
header .muted.small { display: block; }
.logo { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
  background: var(--accent); color: var(--accent-fg); font-size: 18px; }
nav { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
nav a { text-decoration: none; color: var(--muted); padding: 6px 10px; border-radius: 8px; }
nav a:hover { background: var(--bg); color: var(--fg); }
nav a.active { color: var(--fg); background: var(--bg); font-weight: 600; }
main { max-width: 920px; margin: 0 auto; padding: 28px 24px 64px; }
main.narrow { max-width: 520px; }
h1, h2 { margin: 0; font-weight: 650; letter-spacing: -0.01em; }
h1 { font-size: 22px; }
h2 { font-size: 16px; }
p { margin: 10px 0; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 20px; margin: 16px 0; }
.muted-card p { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0 16px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pill { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px;
  border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.pill.ok { color: var(--ok); background: var(--ok-bg); border-color: transparent; }
.pill.warn { color: var(--warn); background: var(--warn-bg); border-color: transparent; }
dl { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; margin: 14px 0; }
dt { color: var(--muted); font-size: 13px; }
dd { margin: 0; word-break: break-all; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
pre { background: var(--bg); padding: 12px; border-radius: 10px; overflow: auto; }
label { display: block; margin: 14px 0; font-size: 14px; }
input { display: block; width: 100%; margin-top: 6px; padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
input:focus { outline: 2px solid var(--fg); outline-offset: 1px; }
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border-radius: 10px; border: 1px solid var(--line); padding: 9px 14px; font: inherit;
  font-weight: 600; cursor: pointer; text-decoration: none; background: var(--card); color: var(--fg); }
button.primary, .button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
button.secondary { color: var(--fg); background: transparent; }
button.danger { color: var(--danger); background: transparent; border-color: var(--danger); }
button.link { border: 0; background: none; color: var(--muted); font-weight: 500; padding: 4px; }
details.card summary { cursor: pointer; }
details.card label { margin-bottom: 0; }
form.inline { display: inline; }
form.logout { margin-left: auto; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.center { text-align: center; }
.center .row { justify-content: center; }
.qr { width: 240px; height: 240px; max-width: 100%; margin: 16px auto; display: block;
  border-radius: 12px; background: #fff; padding: 8px; }
.qr.done, .qr.expired { opacity: .35; }
.status { font-weight: 600; }
.error { color: var(--danger); }
.notice { background: var(--warn-bg); color: var(--warn); border-radius: 10px; padding: 10px 14px; }
.back { display: inline-block; margin-top: 12px; color: var(--muted); text-decoration: none; }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
@media (max-width: 520px) {
  header { padding: 12px 16px; gap: 10px; }
  main { padding: 20px 16px 48px; }
  .qr { width: 200px; height: 200px; }
}
`;
