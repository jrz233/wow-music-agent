/**
 * QQ 音乐 App 扫码登录的**凭据契约**测试。
 *
 * 这里钉的是「扫码成功后到底拿到什么」，而不是二维码长什么样：
 *
 *   1. 扫码状态必须从 MQTT 推送读取，确认后用 musicid + token 调 `Login` 换票；
 *   2. 换回来的 Cookie 必须同时含 **纯数字 `uin`** 与 `qm_keyst`；
 *   3. 数据接口只能带换票后的凭据，二维码阶段的设备 Cookie 不能混进去。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { QQClient, credentialExpiry } from "../src/qq/client";
import { MobileQRSocket, parsePacket } from "../src/qq/mqtt";

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

// ---- MQTT 桩 ----
//
// App 扫码不轮询 CGI，而是等 MQTT 推送。测试里用一个假 WebSocket 扮演服务端：
// 收到 CONNECT 回 CONNACK，收到 SUBSCRIBE 回 SUBACK，再推一条脚本里指定的
// PUBLISH。报文按 MQTT 5 手工拼，正好也验证客户端的解析。

interface SocketScript {
  type: string;
  payload?: string;
  qos?: number;
  packetId?: number;
}

interface FakeSocket {
  url: string;
  protocols: string[] | string | undefined;
  sent: Uint8Array[];
}

function mqttString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [(bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];
}

function mqttVarInt(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

function mqttPacket(type: number, body: number[]): Uint8Array {
  return new Uint8Array([type, ...mqttVarInt(body.length), ...body]);
}

function publishPacket(topic: string, script: SocketScript): Uint8Array {
  const qos = script.qos ?? 0;
  const properties = [0x26, ...mqttString("type"), ...mqttString(script.type)];
  const payload = script.payload ? [...new TextEncoder().encode(script.payload)] : [];
  const packetId = qos > 0 ? [(script.packetId ?? 1) >> 8, (script.packetId ?? 1) & 0xff] : [];
  const body = [
    ...mqttString(topic),
    ...packetId,
    ...mqttVarInt(properties.length),
    ...properties,
    ...payload,
  ];
  return mqttPacket(0x30 | (qos << 1), body);
}

/** 安装假 WebSocket，返回被创建的连接（便于断言握手报文）。 */
function stubQQSocket(script: SocketScript | SocketScript[]): FakeSocket[] {
  const sockets: FakeSocket[] = [];
  const encoder = new TextEncoder();

  class FakeWebSocket extends EventTarget {
    binaryType = "blob";
    readonly sent: Uint8Array[] = [];
    readonly protocols: string[] | string | undefined;

    constructor(
      readonly url: string,
      protocols?: string[] | string,
    ) {
      super();
      this.protocols = protocols;
      sockets.push(this);
      setTimeout(() => this.dispatchEvent(new Event("open")), 0);
    }

    send(data: ArrayBuffer | Uint8Array | string): void {
      const bytes =
        typeof data === "string"
          ? encoder.encode(data)
          : data instanceof Uint8Array
            ? data
            : new Uint8Array(data);
      this.sent.push(bytes);
      const type = (bytes[0] ?? 0) & 0xf0;
      if (type === 0x10) {
        setTimeout(() => this.receive(new Uint8Array([0x20, 0x03, 0x00, 0x00, 0x00])), 0);
      } else if (type === 0x80) {
        const scripts = Array.isArray(script) ? script : [script];
        setTimeout(() => {
          this.receive(new Uint8Array([0x90, 0x04, 0x00, 0x01, 0x00, 0x00]));
          scripts.forEach((item, index) => {
            setTimeout(
              () => this.receive(publishPacket("management.qrcode_login/QR_ID", item)),
              index * 10,
            );
          });
        }, 0);
      }
    }

    close(): void {
      this.dispatchEvent(new Event("close"));
    }

    private receive(bytes: Uint8Array): void {
      this.dispatchEvent(new MessageEvent("message", { data: bytes.buffer }));
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket);
  return sockets;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QQ 音乐 App 扫码", () => {
  it("QQ 音乐 App 二维码：CreateQRCode 直接返回 base64 图片与 qrcodeID", async () => {
    const seen = stubFetch([
      {
        match: "CreateQRCode",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: {
              code: 0,
              data: { qrcode: "data:image/png;base64,AAAA", qrcodeID: "QR_ID" },
            },
          }),
        },
      },
    ]);

    const qr = await new QQClient().createMobileQR();

    expect(qr.qrcodeID).toBe("QR_ID");
    expect(qr.imageDataUrl).toBe("data:image/png;base64,AAAA");
    // 设备身份要跟着会话走，轮询和最终凭据复用同一套。
    expect(qr.cookie).toMatch(/android_id=[0-9a-f]{16}/u);
    expect(qr.cookie).toMatch(/open_udid=[0-9a-f]{32}/u);
    expect(seen.some((item) => item.body.includes("CreateQRCode"))).toBe(true);
  });

  it("Android 登录上下文：先取 QIMEI 与匿名会话，CreateQRCode 带上设备指纹", async () => {
    const seen = stubFetch([
      {
        match: "api.tencentmusic.com",
        reply: {
          body: JSON.stringify({
            code: 0,
            // 上游把 data 再包一层 JSON 字符串，q16/q36 都在里层。
            data: JSON.stringify({
              code: 0,
              msg: "ok",
              data: { q16: "QIMEI16", q36: "QIMEI36" },
            }),
          }),
        },
      },
      {
        match: "music.getSession.session",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { session: { uid: "SESSION_UID", sid: "SESSION_SID" } } },
          }),
        },
      },
      {
        match: "CreateQRCode",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { qrcode: "data:image/png;base64,AAAA", qrcodeID: "QR_ID" } },
          }),
        },
      },
    ]);

    const qr = await new QQClient().createMobileQR();

    // 匿名会话必须在出码之前拿到：换票时要靠它证明「同一台设备」。
    const getSession = seen.findIndex((item) => item.body.includes("music.getSession.session"));
    const create = seen.findIndex((item) => item.body.includes("CreateQRCode"));
    expect(getSession).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(getSession);

    const request = JSON.parse(seen[create]?.body ?? "{}");
    expect(request.comm.QIMEI36).toBe("QIMEI36");
    expect(request.comm.uid).toBe("SESSION_UID");
    expect(request.comm.sid).toBe("SESSION_SID");
    expect(request.comm.ct).toBe("23");
    expect(request.comm.cv).toBe("0");
    expect(request.comm.aid).toMatch(/^[0-9a-f]{16}$/u);
    expect(request.comm.OpenUDID).toMatch(/^[0-9a-f]{32}$/u);
    expect(request.comm.udid).toBe(request.comm.OpenUDID);
    expect(request.comm.os_ver).toBe("15");
    expect(request.comm.phonetype).toBe("V2408A");
    // 凭据要能把这套设备身份带回来，续期才不会换设备。
    expect(qr.cookie).toMatch(/open_udid2=[0-9a-f]{32}/u);
    expect(qr.cookie).toMatch(/imei=\d{15}/u);
    // QIMEI 与匿名会话也必须持久化：冷启动后重新申请会被上游当成新设备。
    expect(qr.cookie).toContain("qimei36=QIMEI36");
    expect(qr.cookie).toContain("session_uid=SESSION_UID");
    expect(qr.cookie).toContain("session_sid=SESSION_SID");
  });

  it("冷启动续期：从凭据恢复 QIMEI 与匿名会话，换票用同一台设备", async () => {
    const payload = JSON.stringify({
      cookies: { qqmusic_uin: { value: "456" }, qqmusic_key: { value: "APP_KEY" } },
    });
    stubQQSocket({ type: "cookies", payload });
    const seen = stubFetch([
      {
        match: "music.login.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { musicid: 456, musickey: "APP_KEY", loginType: 6 } },
          }),
        },
      },
    ]);
    // 模拟 Durable Object 冷启动后只剩加密凭据里的 Cookie。
    const client = new QQClient(
      [
        "android_id=0011223344556677",
        "open_udid=00112233445566778899aabbccddeeff",
        "open_udid2=ffeeddccbbaa99887766554433221100",
        "imei=123456789012345",
        "qimei16=QIMEI16",
        "qimei36=QIMEI36",
        "session_uid=RESTORED_UID",
        "session_sid=RESTORED_SID",
      ].join("; "),
    );

    const state = await client.checkMobileQR("QR_ID", 2_000);
    expect(state.state).toBe("success");

    const login = seen.find((item) => item.body.includes("music.login.LoginServer"));
    const request = JSON.parse(login?.body ?? "{}");
    expect(request.comm.QIMEI36).toBe("QIMEI36");
    expect(request.comm.uid).toBe("RESTORED_UID");
    expect(request.comm.sid).toBe("RESTORED_SID");
    if (state.state === "success") {
      expect(state.result.credential).toContain("qimei36=QIMEI36");
      expect(state.result.credential).toContain("session_uid=RESTORED_UID");
      expect(state.result.credential).toContain("session_sid=RESTORED_SID");
    }
  });

  it("App 扫码状态由 MQTT 推送：scanned / canceled / timeout 映射成已扫 / 过期", async () => {
    const cases: { type: string; want: string }[] = [
      { type: "scanned", want: "scanned" },
      { type: "canceled", want: "expired" },
      { type: "timeout", want: "expired" },
    ];
    for (const item of cases) {
      const sockets = stubQQSocket({ type: item.type });
      const client = new QQClient(
        "android_id=0011223344556677; open_udid=00112233445566778899aabbccddeeff",
      );
      expect((await client.checkMobileQR("QR_ID", 2_000)).state).toBe(item.want);

      // 握手必须带 mqtt 子协议，否则服务端会回 0x9d 重定向。
      expect(sockets[0]?.url).toBe("wss://mu.y.qq.com/ws/handshake");
      expect(sockets[0]?.protocols).toEqual(["mqtt"]);
      const handshake = new TextDecoder().decode(sockets[0]?.sent[0] ?? new Uint8Array());
      expect(handshake).toContain("tmeAppID");
      expect(handshake).toContain("hashTag");
      expect(handshake).toContain("QR_ID");
      const subscribe = new TextDecoder().decode(sockets[0]?.sent[1] ?? new Uint8Array());
      expect(subscribe).toContain("management.qrcode_login/QR_ID");
    }
  });

  it("同一二维码复用一条 MQTT 连接：scanned 之后的 cookies 不会因重连丢掉", async () => {
    const payload = JSON.stringify({
      cookies: { qqmusic_uin: { value: "456" }, qqmusic_key: { value: "APP_KEY" } },
    });
    const sockets = stubQQSocket([{ type: "scanned" }, { type: "cookies", payload }]);
    stubFetch([
      {
        match: "music.login.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { musicid: 456, musickey: "APP_KEY" } },
          }),
        },
      },
    ]);

    const client = new QQClient(
      "android_id=0011223344556677; open_udid=00112233445566778899aabbccddeeff",
    );
    // 模拟会话池：两次长轮询共用同一条连接。
    const socket = new MobileQRSocket("QR_ID");
    expect((await client.checkMobileQR("QR_ID", 2_000, socket)).state).toBe("scanned");
    expect(socket.isClosed).toBe(false);
    expect((await client.checkMobileQR("QR_ID", 2_000, socket)).state).toBe("success");
    // 全程只建连一次：确认后的 cookies 就是推到这条连接上的。
    expect(sockets).toHaveLength(1);
  });

  it("App 扫码成功：MQTT cookies 触发 Login 换票，凭据记 loginType=6", async () => {
    const payload = JSON.stringify({
      cookies: { qqmusic_uin: { value: "456" }, qqmusic_key: { value: "APP_KEY" } },
    });
    const sockets = stubQQSocket({ type: "cookies", payload });
    const seen = stubFetch([
      {
        match: "music.login.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: {
              code: 0,
              data: {
                musicid: 456,
                musickey: "APP_KEY",
                nick: "App 用户",
                loginType: 6,
                refresh_token: "APP_REFRESH",
                openid: "APP_OPENID",
              },
            },
          }),
        },
      },
    ]);

    const client = new QQClient(
      "android_id=0011223344556677; open_udid=00112233445566778899aabbccddeeff",
    );
    const state = await client.checkMobileQR("QR_ID", 2_000);
    expect(state.state).toBe("success");
    if (state.state !== "success") return;

    expect(state.result.credential).toContain("uin=456");
    expect(state.result.credential).toContain("qm_keyst=APP_KEY");
    expect(state.result.credential).toContain("loginType=6");
    expect(state.result.credential).toContain("refresh_token=APP_REFRESH");
    // 登录时的设备身份不能换掉，否则续期会遇到风控。
    expect(state.result.credential).toContain("android_id=0011223344556677");
    expect(state.result.account.nickname).toBe("App 用户");

    const login = seen.find((item) => item.body.includes("music.login.LoginServer"));
    const request = JSON.parse(login?.body ?? "{}");
    expect(request.req_0.param.musicid).toBe(456);
    expect(request.req_0.param.qrCodeID).toBe("QR_ID");
    expect(request.req_0.param.token).toBe("APP_KEY");
    expect(request.comm.tmeLoginType).toBe("6");
    // 换票也必须带同一套设备指纹，否则上游只回笼统的业务错误（50006）。
    expect(request.comm.aid).toMatch(/^[0-9a-f]{16}$/u);
    expect(request.comm.OpenUDID).toMatch(/^[0-9a-f]{32}$/u);
    expect(request.comm.OpenUDID2).toMatch(/^[0-9a-f]{32}$/u);
    expect(request.comm.os_ver).toBe("15");
    expect(request.comm.phonetype).toBe("V2408A");
    // 只建连一次：拿到 cookies 后应立刻换票，不再反复重连。
    expect(sockets).toHaveLength(1);
  });

  it("19 位微信 musicid 原样写进 Login：先转 Number 会丢精度", async () => {
    const uin = "1152921504606846976";
    const payload = JSON.stringify({
      cookies: { qqmusic_uin: { value: uin }, qqmusic_key: { value: "W_X_APP_KEY" } },
    });
    stubQQSocket({ type: "cookies", payload });
    const seen = stubFetch([
      {
        match: "music.login.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: {
              code: 0,
              data: {
                // 上游给字符串形式的完整 uin；数字字段在 JS 里同样会丢精度。
                str_musicid: uin,
                musickey: "W_X_APP_KEY",
                loginType: 1,
              },
            },
          }),
        },
      },
    ]);

    const client = new QQClient(
      "android_id=0011223344556677; open_udid=00112233445566778899aabbccddeeff",
    );
    const state = await client.checkMobileQR("QR_ID", 2_000);
    expect(state.state).toBe("success");
    if (state.state !== "success") return;

    const login = seen.find((item) => item.body.includes("music.login.LoginServer"));
    // 关键：JSON 里必须是完整数字，而不是 1152921504606847000。
    expect(login?.body).toContain(`"musicid":${uin}`);
    expect(login?.body).not.toContain(`"musicid":"${uin}"`);
    expect(state.result.credential).toContain(`uin=${uin}`);
    expect(state.result.credential).toContain("loginType=1");
  });

  it("重复的 cookies 推送只换一次票：同一 token 不能重复调用 Login", async () => {
    const payload = JSON.stringify({
      cookies: { qqmusic_uin: { value: "456" }, qqmusic_key: { value: "APP_KEY" } },
    });
    stubQQSocket([{ type: "cookies", payload }, { type: "cookies", payload }]);
    const seen = stubFetch([
      {
        match: "music.login.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: { code: 0, data: { musicid: 456, musickey: "APP_KEY" } },
          }),
        },
      },
    ]);

    const client = new QQClient(
      "android_id=0011223344556677; open_udid=00112233445566778899aabbccddeeff",
    );
    const socket = new MobileQRSocket("QR_ID");
    expect((await client.checkMobileQR("QR_ID", 2_000, socket)).state).toBe("success");
    // 第二条推送已到，但换票已成功（或正在进行），不能再用同一 token 换一次。
    expect((await client.checkMobileQR("QR_ID", 50, socket)).state).toBe("waiting");
    expect(seen.filter((item) => item.body.includes("music.login.LoginServer"))).toHaveLength(1);
  });

});

describe("MQTT 协议细节", () => {
  it("0x9c（Use Another Server）与 0x9d 一样按 server_reference 重定向", () => {
    for (const reason of [0x9c, 0x9d]) {
      const reference = "node-1";
      const properties = [0x1c, ...mqttString(reference)];
      const body = [0x00, reason, ...mqttVarInt(properties.length), ...properties];
      const packet = parsePacket(mqttPacket(0x20, body));
      expect(packet?.serverReference).toBe(reference);
    }
  });

  it("QoS 1 的推送要回 PUBACK，packet id 不能当成属性解析", async () => {
    const sockets = stubQQSocket({ type: "scanned", qos: 1, packetId: 7 });
    const client = new QQClient(
      "android_id=0011223344556677; open_udid=00112233445566778899aabbccddeeff",
    );
    expect((await client.checkMobileQR("QR_ID", 2_000)).state).toBe("scanned");

    const ack = sockets[0]?.sent.find((bytes) => (bytes[0] ?? 0) === 0x40);
    expect(ack).toEqual(new Uint8Array([0x40, 0x02, 0x00, 0x07]));
  });
});

describe("QQ 续期", () => {
  const now = Math.floor(Date.now() / 1000);

  function cred(...extra: string[]): string {
    return [
      "uin=456",
      "qm_keyst=OLD_KEY",
      "musicid=456",
      "loginType=6",
      "android_id=0011223344556677",
      "open_udid=00112233445566778899aabbccddeeff",
      "open_udid2=ffeeddccbbaa99887766554433221100",
      "imei=123456789012345",
      ...extra,
    ].join("; ");
  }

  it("到期时间取 musickeyCreateTime + keyExpiresIn，缺失时为 0", () => {
    expect(credentialExpiry(cred(`musickeyCreateTime=${now}`, `keyExpiresIn=3600`))).toBe(
      now + 3600,
    );
    // 毫秒时间戳也兼容。
    expect(credentialExpiry(cred(`musickeyCreateTime=${now * 1000}`, "keyExpiresIn=60"))).toBe(
      now + 60,
    );
    expect(credentialExpiry(cred())).toBe(0);
    expect(credentialExpiry(cred(`musickeyCreateTime=${now}`))).toBe(0);
  });

  it("离到期还远时只探活，不消耗 refresh_token", async () => {
    const seen = stubFetch([
      {
        match: "fcg_get_profile_homepage",
        reply: { body: JSON.stringify({ code: 0, data: { creator: { nick: "远未到期" } } }) },
      },
    ]);
    const client = new QQClient(
      cred(
        `musickeyCreateTime=${now}`,
        "keyExpiresIn=86400",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
      ),
    );

    const result = await client.refresh();

    expect(result?.nickname).toBe("远未到期");
    // 30 分钟一次的定时任务不能每次都调续期接口。
    expect(seen.filter((item) => item.body.includes("music.login.LoginServer"))).toHaveLength(0);
    expect(result?.credential).toContain("refresh_token=OLD_REFRESH");
    expect(result?.credential).toContain("refresh_key=OLD_REFRESH_KEY");
    expect(result?.expiresAt).toBe(now + 86400);
  });

  it("临近到期才续期；响应没回 refresh 材料时沿用旧值", async () => {
    const seen = stubFetch([
      {
        match: "music.login.LoginServer",
        reply: {
          body: JSON.stringify({
            code: 0,
            req_0: {
              code: 0,
              data: {
                str_musicid: "456",
                musickey: "NEW_KEY",
                loginType: 6,
                keyExpiresIn: 7200,
                nick: "续期成功",
              },
            },
          }),
        },
      },
    ]);
    const client = new QQClient(
      cred(
        `musickeyCreateTime=${now - 86400}`,
        "keyExpiresIn=3600",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
        "openid=OLD_OPENID",
      ),
    );

    const result = await client.refresh();

    const login = seen.find((item) => item.body.includes("music.login.LoginServer"));
    expect(login).toBeTruthy();
    expect(JSON.parse(login?.body ?? "{}").req_0.param.refresh_token).toBe("OLD_REFRESH");
    expect(result?.nickname).toBe("续期成功");
    expect(result?.credential).toContain("qm_keyst=NEW_KEY");
    // 续期响应只回了新 key：旧 refresh 材料必须保留，否则下一轮再也续不了。
    expect(result?.credential).toContain("refresh_token=OLD_REFRESH");
    expect(result?.credential).toContain("refresh_key=OLD_REFRESH_KEY");
    expect(result?.credential).toContain("openid=OLD_OPENID");
    // 有效期从这次响应算起。
    expect(result?.expiresAt).toBeGreaterThan(now + 7000);
    expect(result?.expiresAt).toBeLessThanOrEqual(now + 7300);
  });

  it("19 位微信 musicid 续期：响应回数字也不丢精度", async () => {
    const uin = "1152921504606846976";
    stubFetch([
      {
        match: "music.login.LoginServer",
        reply: {
          // 直接写原始数字字面量，模拟上游返回 JSON number。
          body: `{"code":0,"req_0":{"code":0,"data":{"musicid":${uin},"musickey":"NEW_KEY","loginType":1,"keyExpiresIn":3600}}}`,
        },
      },
    ]);
    const client = new QQClient(
      [
        `uin=${uin}`,
        "qm_keyst=OLD_KEY",
        `musicid=${uin}`,
        "loginType=1",
        "android_id=0011223344556677",
        "open_udid=00112233445566778899aabbccddeeff",
        "open_udid2=ffeeddccbbaa99887766554433221100",
        "imei=123456789012345",
        `musickeyCreateTime=${now - 86400}`,
        "keyExpiresIn=60",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
      ].join("; "),
    );

    const result = await client.refresh();

    expect(result?.credential).toContain(`uin=${uin}`);
    expect(result?.credential).not.toContain("uin=1152921504606847000");
  });

  it("续期被拒但旧凭据仍可用：保留旧 key，退避后重试而不是判掉线", async () => {
    stubFetch([
      {
        match: "music.login.LoginServer",
        reply: { body: JSON.stringify({ code: 0, req_0: { code: 20279, data: {} } }) },
      },
      {
        match: "fcg_get_profile_homepage",
        reply: { body: JSON.stringify({ code: 0, data: { creator: { nick: "旧凭据仍有效" } } }) },
      },
    ]);
    const client = new QQClient(
      cred(
        `musickeyCreateTime=${now - 86400}`,
        "keyExpiresIn=3600",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
      ),
    );

    const result = await client.refresh();

    expect(result?.nickname).toBe("旧凭据仍有效");
    expect(result?.credential).toContain("qm_keyst=OLD_KEY");
    expect(result?.credential).toContain("refresh_token=OLD_REFRESH");
    const retryAt = Number(result?.credential.match(/refresh_after=(\d+)/u)?.[1] ?? 0);
    // 已过本地到期时间，但资料接口还能读：按 30 分钟退避重试。
    expect(retryAt).toBeGreaterThan(now);
    expect(retryAt).toBeLessThanOrEqual(now + 31 * 60);
  });

  it("续期遇到网络错误要向上抛，不能误判成已掉线", async () => {
    stubFetch([
      {
        match: "music.login.LoginServer",
        reply: () => {
          throw new Error("network down");
        },
      },
    ]);
    const client = new QQClient(
      cred(
        `musickeyCreateTime=${now - 86400}`,
        "keyExpiresIn=60",
        "refresh_token=OLD_REFRESH",
        "refresh_key=OLD_REFRESH_KEY",
      ),
    );

    await expect(client.refresh()).rejects.toThrow("network down");
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
