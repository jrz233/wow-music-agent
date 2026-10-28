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
        match: "ptqrlogin",
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
        match: "ptqrlogin",
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
      { match: "ptqrlogin", reply: { body: `ptuiCB('0','0','${JUMP}','0','登录成功','X')` } },
      { match: "check_sig", reply: { status: 200 } },
    ]);

    const client = new QQClient();
    await client.createQR();
    await expect(client.checkQR()).rejects.toThrow(/p_skey/u);
    expect(seen.some((item) => item.body.includes("QQConnectLogin.LoginServer"))).toBe(false);
  });

  it("check_sig 要跟着跳转走，p_skey 在最后一跳才下发", async () => {
    const seen = stubFetch([
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      {
        match: "ptqrlogin",
        reply: { body: `ptuiCB('0','0','${JUMP}','0','登录成功','X')` },
      },
      {
        match: "check_sig",
        reply: ((request: Seen): Reply =>
          request.url.includes("hop=2")
            ? { headers: { "set-cookie": "p_skey=P_SKEY_VALUE; Domain=qq.com; Path=/" } }
            : {
                status: 302,
                headers: { location: JUMP.replace("check_sig?", "check_sig?hop=2&") },
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
    expect(seen.some((item) => item.url.includes("hop=2"))).toBe(true);
  });

  it("轮询回到吐出二维码的那台机器", async () => {
    const seen = stubFetch([
      // xui 这一路拿不到图，落到 ssl 那一路。
      { match: "xui.ptlogin2.qq.com", reply: { body: "<html>维护中</html>" } },
      { match: "ptqrshow", reply: { body: PNG_BYTES, headers: { "set-cookie": "qrsig=xyz; Path=/" } } },
      { match: "ptqrlogin", reply: { body: "ptuiCB('66','0','','0','二维码未失效。','')" } },
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
    expect(cookie).toContain("uin=123456789");
    expect(cookie).toContain("qm_keyst=KEY");
    expect(cookie).not.toContain("qrsig");
    expect(cookie).not.toContain("pt_login_sig");
  });

  it("uin 只认纯数字；空 uin 不会伪装成已登录", () => {
    expect(new QQClient("qqmusic_uin=o123; qm_keyst=k").uin).toBe("123");
    expect(new QQClient("uin=o0; qm_keyst=k").uin).toBe("");
    expect(new QQClient("").uin).toBe("");
    expect(new QQClient("").musickey).toBe("");
  });
});
