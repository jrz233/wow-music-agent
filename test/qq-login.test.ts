/**
 * QQ 扫码登录的**凭据契约**测试。
 *
 * 这里钉的是「扫码成功后到底拿到什么」，而不是二维码长什么样：
 *
 *   1. 必须用 `QQConnectLogin.LoginServer/QQLogin` 拿一次性 code 换票；
 *   2. 换回来的 Cookie 必须同时含 **纯数字 `uin`** 与 `qm_keyst`；
 *   3. 数据接口只能带换票后的凭据，二维码阶段的 Cookie 不能混进去。
 *
 * 这三条以前全是错的：代码跟着 ptlogin 的 302 链抓网页版 Cookie，`uin` 为空，
 * 于是面板显示「已登录」，歌单/每日/漫游却一律 `500003` / `1000`。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { QQClient } from "../src/qq/client";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface Seen {
  url: string;
  method: string;
  body: string;
  cookie: string;
}

type Reply = { status?: number; body?: string | Uint8Array; headers?: Record<string, string> };

/** 极简路由桩：按 URL 片段命中，返回预设响应并记录请求。 */
function stubFetch(routes: { match: string; reply: Reply | ((seen: Seen) => Reply) }[]): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const record: Seen = {
        url,
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
        cookie: String((init?.headers as Record<string, string> | undefined)?.Cookie ?? ""),
      };
      seen.push(record);
      for (const route of routes) {
        // musicu 的模块名在 body 里，所以匹配串同时看 URL 与 body。
        if (!url.includes(route.match) && !record.body.includes(route.match)) continue;
        const reply = typeof route.reply === "function" ? route.reply(record) : route.reply;
        return new Response(reply.body ?? "", {
          status: reply.status ?? 200,
          headers: reply.headers,
        });
      }
      return new Response("", { status: 404 });
    }),
  );
  return seen;
}

/** 扫码成功时 ptuiCB 回的那条跳转。 */
const JUMP =
  "https://ssl.ptlogin2.graph.qq.com/check_sig?uin=123456789&ptsigx=abc123&ptredirect=0";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QQ QR login", () => {
  it("用 QQLogin 换取带 uin / qm_keyst 的凭据，而不是抓 302 链上的网页 Cookie", async () => {
    const seen = stubFetch([
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      {
        match: "/ptqrlogin",
        reply: { body: `ptuiCB('0','0','${JUMP}','0','登录成功','%E5%B0%8F%E6%98%8E')` },
      },
      {
        match: "check_sig",
        reply: { headers: { "set-cookie": "p_skey=P_SKEY_VALUE; Domain=qq.com; Path=/" } },
      },
      {
        match: "graph.qq.com/oauth2.0/authorize",
        reply: {
          status: 302,
          headers: {
            location: "https://y.qq.com/portal/wx_redirect.html?code=ONE_TIME_CODE&state=x",
          },
        },
      },
      {
        match: "QQConnectLogin.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: {
              code: 0,
              data: { str_musicid: "123456789", musickey: "MUSIC_KEY_VALUE", nick: "小明" },
            },
          }),
        },
      },
      {
        match: "music.getSession.session",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { session: { uid: "6822168287", sid: "20261028163110" } } },
          }),
        },
      },
      {
        match: "fcg_get_profile_homepage",
        reply: { body: JSON.stringify({ code: 0, data: { creator: { nick: "小明" } } }) },
      },
    ]);

    const client = new QQClient();
    await client.createQR();
    const state = await client.checkQR();

    expect(state.state).toBe("success");
    if (state.state !== "success") return;

    // 凭据必须能被数据接口直接使用：uin 是纯数字，qm_keyst 是换票结果。
    expect(state.result.credential).toContain("uin=123456789");
    expect(state.result.credential).toContain("qm_keyst=MUSIC_KEY_VALUE");
    expect(state.result.account.userId).toBe("123456789");
    expect(state.result.account.nickname).toBe("小明");

    // 换票链路：check_sig → authorize(code) → QQLogin(code)，一步都不能少。
    const uinLogin = seen.find((item) => item.body.includes("QQConnectLogin.LoginServer"));
    expect(uinLogin).toBeDefined();
    expect(JSON.parse(uinLogin?.body ?? "{}").req_0.param.code).toBe("ONE_TIME_CODE");
    expect(seen.some((item) => item.url.includes("graph.qq.com/oauth2.0/authorize"))).toBe(true);

    // 登录阶段只允许碰这几台主机：不再跟着 302 链去 y.qq.com 抓网页 Cookie。
    // 登录阶段只允许碰这几台主机：不再跟着 302 链去 y.qq.com 抓网页 Cookie。
    const hosts = new Set(seen.map((item) => new URL(item.url).hostname));
    for (const host of hosts) {
      expect(
        ["y.qq.com", "graph.qq.com", "xui.ptlogin2.qq.com", "ssl.ptlogin2.graph.qq.com", "u.y.qq.com"],
      ).toContain(host);
    }
    // 授权回跳只读 `location`，不能真的去打开那个页面（会把 code 带进日志）。
    expect(seen.some((item) => item.url.includes("wx_redirect"))).toBe(false);
  });

  it("换票没给数字 musicid 时直接失败，不落一份坏凭据", async () => {
    stubFetch([
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      {
        match: "/ptqrlogin",
        reply: { body: `ptuiCB('0','0','${JUMP}','0','登录成功','X')` },
      },
      {
        match: "check_sig",
        reply: { headers: { "set-cookie": "p_skey=P_SKEY_VALUE; Domain=qq.com; Path=/" } },
      },
      {
        match: "oauth2.0/authorize",
        reply: { status: 302, headers: { location: "https://y.qq.com/?code=C" } },
      },
      {
        match: "music.getSession.session",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { session: { uid: "1", sid: "2" } } },
          }),
        },
      },
      {
        match: "QQConnectLogin.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 1000, data: { str_musicid: "", musickey: "" } },
          }),
        },
      },
    ]);

    const client = new QQClient();
    await client.createQR();
    await expect(client.checkQR()).rejects.toThrow(/凭据|登录/u);
  });

  it("check_sig 没给 p_skey 时停在授权前，不会发出 QQLogin", async () => {
    const seen = stubFetch([
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      { match: "/ptqrlogin", reply: { body: `ptuiCB('0','0','${JUMP}','0','登录成功','X')` } },
      { match: "check_sig", reply: { status: 200 } },
    ]);

    const client = new QQClient();
    await client.createQR();
    await expect(client.checkQR()).rejects.toThrow(/p_skey/u);
    expect(seen.some((item) => item.body.includes("QQConnectLogin.LoginServer"))).toBe(false);
    // 第一次不带 Cookie，失败后还要按浏览器方式重试一次。
    expect(seen.filter((item) => item.url.includes("check_sig"))).toHaveLength(2);
  });

  it("check_sig 第一次不带 Cookie；拿不到 p_skey 时用浏览器方式重试", async () => {
    // 线上就是这样：整只扁平 Cookie jar 发过去，QQ 回 `p_skey=` 空值 + `p_skey_forbid`。
    // 换成「先不带 Cookie，再只带 Domain 匹配的 Cookie 重试」才拿得到 p_skey。
    const seen = stubFetch([
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      {
        match: "/ptqrlogin",
        reply: {
          body: `ptuiCB('0','0','${JUMP}','0','登录成功','X')`,
          headers: {
            "set-cookie":
              "uin=o123456789; Path=/; Domain=.qq.com, skey=PT_SKEY; Path=/; Domain=.qq.com, " +
              "host_only=1; Path=/",
          },
        },
      },
      {
        match: "check_sig",
        reply: ((request: Seen): Reply =>
          request.url.includes("ptredirect=100")
            ? {
                status: 302,
                headers: {
                  location: "https://graph.qq.com/oauth2.0/login_jump",
                  "set-cookie": "p_skey=; Path=/; Domain=.qq.com, p_skey_forbid=1; Path=/; Domain=.qq.com",
                },
              }
            : {
                headers: {
                  "set-cookie": "p_skey=P_SKEY_VALUE; Path=/; Domain=.qq.com",
                },
              }),
      },
      {
        match: "graph.qq.com/oauth2.0/authorize",
        reply: {
          status: 302,
          headers: {
            location: "https://y.qq.com/portal/wx_redirect.html?code=ONE_TIME_CODE&state=x",
          },
        },
      },
      {
        match: "QQConnectLogin.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: {
              code: 0,
              data: { str_musicid: "123456789", musickey: "MUSIC_KEY_VALUE", nick: "小明" },
            },
          }),
        },
      },
      {
        match: "music.getSession.session",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { session: { uid: "6822168287", sid: "20261028163110" } } },
          }),
        },
      },
    ]);

    const client = new QQClient();
    await client.createQR();
    const state = await client.checkQR();
    expect(state.state).toBe("success");

    const checks = seen.filter((item) => item.url.includes("check_sig"));
    expect(checks).toHaveLength(2);
    // 第一次：自己拼参数、不带 Cookie。
    expect(checks[0]?.url).toContain("ptredirect=100");
    expect(checks[0]?.cookie).toBe("");
    // 第二次：打开 ptlogin 给的地址，只带 Domain 匹配 check_sig 主机的 Cookie。
    expect(checks[1]?.url).toBe(JUMP);
    expect(checks[1]?.cookie).toContain("uin=o123456789");
    expect(checks[1]?.cookie).toContain("skey=PT_SKEY");
    expect(checks[1]?.cookie).not.toContain("host_only");

    // 授权只带 check_sig 下发的 Cookie（p_skey / p_uin / pt4_token…），
    // 不把二维码阶段的 qrsig / pt_login_sig 带过去。
    const oauth = seen.find((item) => item.url.includes("oauth2.0/authorize"));
    expect(oauth?.cookie).toContain("p_skey=P_SKEY_VALUE");
    expect(oauth?.cookie).not.toContain("qrsig");
    expect(oauth?.cookie).not.toContain("pt_login_sig");
  });

  it("多个 Cookie 挤在同一个 Set-Cookie 头里时，p_skey 不能丢", async () => {
    // 线上 QQ 就是这么回的：一个 Set-Cookie 头里用逗号塞了两个 Cookie，
    // 而 Expires 日期里也有逗号。只按 `;` 取第一段会丢掉后面的 p_skey。
    const seen = stubFetch([
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      {
        match: "/ptqrlogin",
        reply: {
          body: `ptuiCB('0','0','${JUMP}','0','登录成功','X')`,
          headers: {
            "set-cookie": "uin=o123456789; Path=/; Domain=.qq.com, skey=PT_SKEY; Path=/; Domain=.qq.com",
          },
        },
      },
      {
        match: "check_sig",
        reply: {
          status: 302,
          headers: {
            location: "https://graph.qq.com/oauth2.0/login_jump",
            "set-cookie":
              "pt_oauth_token=oauth; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/, p_skey=P_SKEY_VALUE; Path=/",
          },
        },
      },
      {
        match: "graph.qq.com/oauth2.0/authorize",
        reply: {
          status: 302,
          headers: { location: "https://y.qq.com/portal/wx_redirect.html?code=ONE_TIME_CODE&state=x" },
        },
      },
      {
        match: "music.getSession.session",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { session: { uid: "1", sid: "2" } } },
          }),
        },
      },
      {
        match: "QQConnectLogin.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { str_musicid: "123456789", musickey: "MUSIC_KEY_VALUE" } },
          }),
        },
      },
    ]);

    const client = new QQClient();
    await client.createQR();
    const state = await client.checkQR();
    expect(state.state).toBe("success");

    // 同一个头里的两个 Cookie 都要认出来：p_skey 用来算 g_tk，
    // pt_oauth_token 要跟授权请求一起发回 graph.qq.com。
    const oauth = seen.find((item) => item.url.includes("oauth2.0/authorize"));
    expect(oauth?.cookie).toContain("p_skey=P_SKEY_VALUE");
    expect(oauth?.cookie).toContain("pt_oauth_token=oauth");
  });

  it("轮询回到吐出二维码的那台机器", async () => {
    const seen = stubFetch([
      // xui 这一路拿不到图，落到 ssl 那一路。
      { match: "xui.ptlogin2.qq.com", reply: { body: "<html>维护中</html>" } },
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      { match: "/ptqrlogin", reply: { body: "ptuiCB('66','0','','0','二维码未失效。','')" } },
    ]);

    const first = new QQClient();
    const qr = await first.createQR();
    expect(qr.endpoint).toBe("ssl");

    // 换一个新的 client（管理页每次轮询都是新请求）——入口标识必须跟着会话走，
    // 否则轮询跑到另一台机器上，qrsig 对不上，状态永远停在「等待扫码」。
    const second = new QQClient(qr.cookie, qr.endpoint);
    await second.checkQR();

    const poll = seen.find((item) => item.url.includes("ptqrlogin"));
    expect(poll?.url).toContain("ssl.ptlogin2.qq.com/ptqrlogin");
  });
});

describe("QQ data calls", () => {
  it("数据接口只带换票后的 uin / qm_keyst，不把二维码阶段的 Cookie 带出去", async () => {
    const seen = stubFetch([{ match: "musicu.fcg", reply: { body: JSON.stringify({ code: 0, req_0: { code: 0, data: {} } }) } }]);

    const client = new QQClient(
      "qrsig=xyz; pt_login_sig=abc; uin=123456789; qm_keyst=KEY; android_id=0011223344556677; open_udid=00112233445566778899aabbccddeeff",
    );
    await client.call("music.musicasset.PlaylistBaseRead", "GetPlaylistByUin", { uin: "123456789" });

    const cookie = seen[0]?.cookie ?? "";
    // musicu 用网页版 Cookie 约定：`uin` 必须带 `o` 前缀，否则 login_uin 是 0，
    // 歌单详情这类需要登录态的模块会回 -100006。
    expect(cookie).toContain("uin=o123456789");
    expect(cookie).toContain("qm_keyst=KEY");
    expect(cookie).not.toContain("qrsig");
    expect(cookie).not.toContain("pt_login_sig");
  });

  it("data.code 非 0 时不能当成空数据", async () => {
    stubFetch([
      {
        match: "musicu.fcg",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { code: -100006, msg: "get diss info from tmem error", songlist: [] } },
          }),
        },
      },
    ]);
    const client = new QQClient("uin=123456789; qm_keyst=KEY");
    await expect(
      client.call("music.srfDissInfo.DissInfo", "CgiGetDiss", { disstid: 201 }),
    ).rejects.toThrow("-100006");
  });

  it("uin 只认纯数字；空 uin 不会伪装成已登录", () => {
    expect(new QQClient("qqmusic_uin=o123; qm_keyst=k").uin).toBe("123");
    expect(new QQClient("uin=o0; qm_keyst=k").uin).toBe("");
    expect(new QQClient("").uin).toBe("");
    expect(new QQClient("").musickey).toBe("");
  });
});
