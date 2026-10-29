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
  /** 下一次自动刷新的时刻；0 表示没有可刷新的会话。 */
  nextRefreshAt: number;
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
    </main>
    <script nonce="${nonce}">
    (function () {
      var form = document.querySelector('form[method="post"]');
      if (!form) return;
      form.addEventListener('submit', function () {
        var button = form.querySelector('button[type="submit"]');
        if (!button) return;
        button.disabled = true;
        button.textContent = '正在跳转…';
      });
    })();
    </script>`,
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
        <form method="post" action="/admin/unpair" class="inline" data-ajax data-busy="正在解除…">
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
    </main>
    <script nonce="${nonce}">${DASHBOARD_SCRIPT}</script>`,
  );
}

/**
 * 管理页的全部交互都走 fetch，不整页跳转。
 *
 * - 服务平台类操作（刷新令牌、退出平台）与解绑：提交后用响应里的 HTML 就地替换
 *   `<main>` 和 `<header>`，地址栏同步成带 message 的地址，按钮在请求期间显示进行中。
 * - 连接 wow-server：成功后拿到中转页，再跳去 wow-server 授权（跨站，无法避免）。
 * - 扫码登录：二维码就地展开、轮询状态，成功后重新拉取概览而不是刷新整页。
 *
 * 替换后的 DOM 要重新绑定事件，所以入口统一放在 `ready()`。脚本走 nonce，不依赖
 * 任何内联事件属性。
 */
const DASHBOARD_SCRIPT = `
(function () {
  var generation = {};
  var timers = {};

  function slotOf(platform) {
    return document.querySelector('[data-slot="' + platform + '"]');
  }

  function loginButton(platform) {
    return document.querySelector('[data-login="' + platform + '"]');
  }

  function setLoginButton(platform, busy, label) {
    var button = loginButton(platform);
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? (label || '二维码已显示') : '扫码登录';
  }

  function text(tag, className, value) {
    var node = document.createElement(tag);
    node.className = className;
    node.textContent = value;
    return node;
  }

  function reset(platform, message) {
    var slot = slotOf(platform);
    if (!slot) return;
    slot.innerHTML = '';
    slot.appendChild(text('p', 'error small', message));
    var again = document.createElement('button');
    again.type = 'button';
    again.className = 'secondary';
    again.textContent = '重新获取二维码';
    again.addEventListener('click', function () { start(platform); });
    slot.appendChild(again);
    setLoginButton(platform, false);
  }

  function stop(platform, token) {
    if (generation[platform] !== token) return false;
    if (timers[platform]) {
      clearTimeout(timers[platform]);
      timers[platform] = null;
    }
    return true;
  }

  function poll(platform, slot, token) {
    var status = slot.querySelector('[data-status]');
    var qr = slot.querySelector('img.qr');
    function tick() {
      if (!stop(platform, token)) return;
      timers[platform] = null;
      fetch('/admin/api/' + platform + '/status', { cache: 'no-store' })
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          if (!stop(platform, token)) return;
          if (data.state === 'success') {
            if (status) status.textContent = '登录成功，正在刷新…';
            if (qr) qr.classList.add('done');
            generation[platform] += 1;
            setTimeout(refreshDashboard, 700);
            return;
          }
          if (data.state === 'scanned') {
            if (status) status.textContent = '已扫码，请在手机上确认';
          } else if (data.state === 'expired') {
            reset(platform, '二维码已过期');
            return;
          } else if (data.state === 'error') {
            reset(platform, data.message || '登录失败，请重试');
            return;
          } else if (status) {
            status.textContent = '等待扫码…';
          }
          timers[platform] = setTimeout(tick, 2000);
        })
        .catch(function () {
          if (!stop(platform, token)) return;
          if (status) status.textContent = '网络异常，稍后重试…';
          timers[platform] = setTimeout(tick, 3000);
        });
    }
    timers[platform] = setTimeout(tick, 500);
  }

  function start(platform) {
    var slot = slotOf(platform);
    if (!slot) return;
    generation[platform] = (generation[platform] || 0) + 1;
    var token = generation[platform];
    if (timers[platform]) {
      clearTimeout(timers[platform]);
      timers[platform] = null;
    }
    slot.hidden = false;
    slot.innerHTML = '';
    slot.appendChild(text('p', 'muted small', '正在获取二维码…'));
    setLoginButton(platform, true, '正在获取二维码…');
    fetch('/admin/api/' + platform + '/qr', { cache: 'no-store' })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!stop(platform, token)) return;
        if (!result.ok || !result.data || !result.data.imageDataUrl) {
          reset(platform, (result.data && result.data.message) || '获取二维码失败，请重试');
          return;
        }
        slot.innerHTML = '';
        var image = document.createElement('img');
        image.className = 'qr';
        image.alt = '登录二维码';
        image.src = result.data.imageDataUrl;
        slot.appendChild(image);
        var status = text('p', 'status', '等待扫码…');
        status.setAttribute('data-status', '');
        slot.appendChild(status);
        slot.appendChild(text('p', 'muted small', '二维码由本 Agent 服务端获取。'));
        setLoginButton(platform, true);
        poll(platform, slot, token);
      })
      .catch(function () {
        if (!stop(platform, token)) return;
        reset(platform, '网络异常，请重试');
      });
  }

  /** 用服务端渲染的新 HTML 就地替换页面骨架，不触发整页加载。 */
  function swap(html, url) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var freshMain = doc.querySelector('main');
    var main = document.querySelector('main');
    if (!freshMain || !main) {
      location.reload();
      return;
    }
    // 旧页面上可能还有轮询在跑，换 DOM 前先让它们失效。
    for (var platform in generation) {
      if (Object.prototype.hasOwnProperty.call(generation, platform)) {
        generation[platform] += 1;
      }
    }
    for (var pending in timers) {
      if (Object.prototype.hasOwnProperty.call(timers, pending) && timers[pending]) {
        clearTimeout(timers[pending]);
        timers[pending] = null;
      }
    }
    var freshHeader = doc.querySelector('header');
    var header = document.querySelector('header');
    if (freshHeader && header) header.replaceWith(freshHeader);
    main.replaceWith(freshMain);
    if (url) history.replaceState(null, '', url.pathname + url.search);
    ready();
  }

  /** 重新拉取概览；扫码成功、操作完成后都用它，避免整页刷新。 */
  function refreshDashboard() {
    fetch('/admin', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) {
        var finalUrl = new URL(response.url, location.href);
        if (finalUrl.pathname === '/admin/login') {
          location.assign('/admin/login');
          return null;
        }
        if (!response.ok) throw new Error('bad response');
        return response.text();
      })
      .then(function (html) {
        if (html) swap(html, null);
      })
      .catch(function () {
        location.reload();
      });
  }

  function errorNote(form, message) {
    var note = document.createElement('p');
    note.className = 'error small';
    note.textContent = message;
    form.parentNode.insertBefore(note, form.nextSibling);
    setTimeout(function () {
      if (note.parentNode) note.parentNode.removeChild(note);
    }, 4000);
  }

  /**
   * 表单的无感提交：按钮先进入进行中，再把响应里的页面骨架换进来。
   *
   * 服务端的 POST 都回 303 到 /admin?message=…；fetch 自动跟随，拿到的就是带
   * 消息横幅的整页 HTML。连接 wow-server 例外——那一步要跨站去授权，只能读取
   * 中转页里的 meta refresh 地址再跳转。
   */
  function submit(form, button) {
    if (form.getAttribute('data-busy-active') === '1') return;
    form.setAttribute('data-busy-active', '1');
    var original = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = form.getAttribute('data-busy') || '处理中…';
    }
    var body = new URLSearchParams();
    new FormData(form).forEach(function (value, key) {
      body.append(key, String(value));
    });
    fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
      .then(function (response) {
        var finalUrl = new URL(response.url, location.href);
        return response.text().then(function (text) {
          return { response: response, text: text, finalUrl: finalUrl };
        });
      })
      .then(function (result) {
        if (result.finalUrl.pathname === '/admin/login') {
          location.assign('/admin/login');
          return;
        }
        var doc = new DOMParser().parseFromString(result.text, 'text/html');
        var meta = doc.querySelector('meta[http-equiv="refresh"]');
        if (meta) {
          var match = /url=(.*)$/i.exec(meta.getAttribute('content') || '');
          if (match) {
            location.assign(match[1]);
            return;
          }
        }
        var freshMain = doc.querySelector('main');
        if (freshMain) {
          var target = result.finalUrl.pathname === '/admin' ? result.finalUrl : null;
          swap(result.text, target);
          return;
        }
        if (!result.response.ok) throw new Error('request failed');
        location.reload();
      })
      .catch(function () {
        form.removeAttribute('data-busy-active');
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
        errorNote(form, '网络异常，请重试');
      });
  }

  function ready() {
    var buttons = document.querySelectorAll('[data-login]');
    for (var index = 0; index < buttons.length; index += 1) {
      (function (button) {
        var platform = button.getAttribute('data-login');
        if (!platform) return;
        button.addEventListener('click', function () { start(platform); });
      })(buttons[index]);
    }
    var forms = document.querySelectorAll('form[data-ajax]');
    for (var position = 0; position < forms.length; position += 1) {
      (function (form) {
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          submit(form, form.querySelector('button[type="submit"], button:not([type])'));
        });
      })(forms[position]);
    }
  }

  ready();
})();
`;

/**
 * 已登录后的「连接 wow-server」表单。
 *
 * 与登录页的同名输入相比，这里带 CSRF 并走会话校验；提交后同样落到中转页。
 */
function authorizeForm(csrf: string, serverUrl: string): string {
  return `<form method="post" action="/admin/connect" data-ajax data-busy="正在连接…">
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
  const token = tokenState(platform);
  const badge = platform.loggedIn
    ? platform.status === "degraded"
      ? `<span class="pill warn">刷新失败</span>`
      : `<span class="pill ok">已登录</span>`
    : `<span class="pill">未登录</span>`;
  const detail = platform.loggedIn
    ? `<dl>
        <dt>账号</dt><dd>${escapeHtml(platform.nickname || platform.accountId || "—")}</dd>
        <dt>令牌状态</dt><dd><span class="pill ${token.tone}">${token.label}</span></dd>
        <dt>有效期至</dt><dd>${platform.expiresAt ? formatTime(platform.expiresAt) : "由平台决定"}</dd>
        <dt>最近刷新</dt><dd>${platform.lastRefreshAt ? formatTime(platform.lastRefreshAt) : "—"}</dd>
        <dt>下次自动刷新</dt><dd>${platform.nextRefreshAt ? formatTime(platform.nextRefreshAt) : "等待安排"}</dd>
      </dl>
      <p class="muted small">令牌由后台定时自动续期，通常无需手动操作。</p>
      <div class="actions">
        <form method="post" action="/admin/api/platform/${platform.platform}/refresh" data-ajax data-busy="正在刷新…">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
          <button type="submit" class="secondary">立即刷新令牌</button>
        </form>
        <form method="post" action="/admin/api/platform/${platform.platform}/logout" data-ajax data-busy="正在退出…">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
          <button type="submit" class="danger">退出登录</button>
        </form>
      </div>`
    : `<p class="muted">扫码后即可读取该平台的歌单、收藏、每日推荐与漫游。</p>
      <div class="actions">
        <button type="button" class="primary" data-login="${platform.platform}">扫码登录</button>
      </div>
      <div class="qr-slot" data-slot="${platform.platform}" hidden></div>`;
  const error = platform.lastError
    ? `<p class="error small">${escapeHtml(platform.lastError)}</p>`
    : "";
  return `<div class="card">
    <div class="row"><h2>${escapeHtml(label)}</h2>${badge}</div>
    ${detail}
    ${error}
  </div>`;
}

/** 令牌是否还可用的粗略判断；真正的续期由 alarm 自动完成。 */
function tokenState(platform: PlatformView): { tone: string; label: string } {
  if (platform.status === "degraded") {
    return { tone: "warn", label: "刷新失败" };
  }
  if (!platform.expiresAt) {
    return { tone: "ok", label: "自动续期" };
  }
  if (platform.expiresAt <= Math.floor(Date.now() / 1000)) {
    return { tone: "warn", label: "可能已过期" };
  }
  return { tone: "ok", label: "有效" };
}

function chrome(active: string, csrf: string, authenticated: boolean): string {
  const navigation = authenticated
    ? `<nav>
        <a href="/admin" class="${active === "概览" ? "active" : ""}">概览</a>
      </nav>
      <form method="post" action="/admin/logout" class="logout" data-ajax data-busy="正在退出…">
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

/** 北京时间（UTC+8），不依赖运行环境的时区设置。 */
function formatTime(seconds: number): string {
  if (!seconds) return "—";
  const shifted = new Date((seconds + 8 * 3600) * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
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
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.grid > .card { margin: 0; }
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
.actions form { margin: 0; }
.qr-slot { margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--line); text-align: center; }
.qr-slot .qr { margin: 12px auto 8px; }
.qr-slot button { margin-top: 8px; }
[hidden] { display: none !important; }
button:disabled { opacity: .55; cursor: default; }
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
@media (max-width: 600px) {
  header { padding: 12px 16px; gap: 10px; }
  header .brand { width: 100%; }
  nav { flex: 1 1 auto; }
  form.logout { margin-left: auto; }
  main { padding: 20px 16px 48px; }
  .card { padding: 16px; border-radius: 14px; }
  dl { grid-template-columns: 88px 1fr; }
  .actions > form { flex: 1 1 140px; }
  .actions > form button, .actions > button, .actions > .button { width: 100%; }
  .qr { width: 200px; height: 200px; }
}
`;
