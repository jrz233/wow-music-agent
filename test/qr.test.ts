import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecipheriv } from "node:crypto";
import { QQClient } from "../src/qq/client";
import { NeteaseClient } from "../src/netease/client";
import { aes128EcbEncrypt } from "../src/netease/aes";
import { sniffImageMime } from "../src/shared/image";

/** 8 字节 PNG 魔数 + 一点填充，够用来做类型判断。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image sniffing", () => {
  it("detects PNG / JPEG and rejects everything else", () => {
    expect(sniffImageMime(PNG_BYTES)).toBe("image/png");
    expect(sniffImageMime(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });
});

describe("QQ QR", () => {
  it("accepts a PNG that comes without a content-type header", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/cgi-bin/xlogin")) {
          return new Response("<html></html>", {
            status: 200,
            headers: { "set-cookie": "pt_login_sig=abc; Path=/" },
          });
        }
        if (url.includes("ptqrshow")) {
          // 真实响应就是这样：PNG，但没有 content-type 头。
          return new Response(PNG_BYTES, {
            status: 200,
            headers: { "set-cookie": "qrsig=xyz; Path=/" },
          });
        }
        return new Response("ptuiCB('66','0','','0','二维码未失效。','')", { status: 200 });
      }),
    );

    const client = new QQClient();
    const qr = await client.createQR();

    expect(qr.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(qr.cookie).toContain("qrsig=xyz");
    expect(qr.cookie).toContain("pt_login_sig=abc");
    expect(calls.some((url) => url.includes("xui.ptlogin2.qq.com"))).toBe(true);

    const state = await client.checkQR();
    expect(state.state).toBe("waiting");
  });

  it("falls back to the other ptlogin endpoint when the first one has no image", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("xui.ptlogin2.qq.com")) {
          return new Response("<html>维护中</html>", { status: 200 });
        }
        if (url.includes("ptqrshow")) {
          return new Response(PNG_BYTES, {
            status: 200,
            headers: { "set-cookie": "qrsig=fallback; Path=/" },
          });
        }
        return new Response("ptuiCB('66','0','','0','二维码未失效。','')", { status: 200 });
      }),
    );

    const client = new QQClient();
    const qr = await client.createQR();

    expect(qr.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(qr.cookie).toContain("qrsig=fallback");
    expect(calls.some((url) => url.includes("ssl.ptlogin2.qq.com/ptqrshow"))).toBe(true);
  });

  it("fails when no endpoint returns an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>维护中</html>", { status: 200 })),
    );
    const client = new QQClient();
    await expect(client.createQR()).rejects.toThrow(/二维码/u);
  });

  it("maps the ptuiCB status codes", async () => {
    const responses = new Map<string, string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("ptqrshow")) {
          return new Response(PNG_BYTES, {
            status: 200,
            headers: { "set-cookie": "qrsig=xyz; Path=/" },
          });
        }
        return new Response(responses.get("code") ?? "ptuiCB('66','','','','','')", { status: 200 });
      }),
    );

    const client = new QQClient();
    await client.createQR();

    responses.set("code", "ptuiCB('67','0','','0','二维码已被扫描。','')");
    expect((await client.checkQR()).state).toBe("scanned");

    responses.set("code", "ptuiCB('65','0','','0','二维码已失效。','')");
    expect((await client.checkQR()).state).toBe("expired");
  });
});

/** 把 eapi 响应体按协议加密：登录链路读的是密文，不是明文 JSON。 */
function eapiResponse(payload: unknown): Response {
  const bytes = aes128EcbEncrypt(
    new TextEncoder().encode(EAPI_KEY),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
}

const EAPI_KEY = "e82ckenh8dichen8";

/** 解开 eapi 请求体，好断言「带没带 e_r / header」。 */
function decodeEapiParams(body: string): Record<string, unknown> {
  const params = new URLSearchParams(body).get("params") ?? "";
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(EAPI_KEY), Buffer.alloc(0));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(params, "hex")),
    decipher.final(),
  ]).toString("utf8");
  const match = /^(.*?)-36cd479b6b5-(.*?)-36cd479b6b5-[0-9a-f]{32}$/u.exec(plain);
  if (!match) {
    throw new Error("eapi 请求体格式不对");
  }
  return JSON.parse(match[2] as string) as Record<string, unknown>;
}

describe("NetEase QR", () => {
  it("renders the QR locally and asks the interface host for the key", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          body: String(init?.body ?? ""),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (url.includes("/eapi/login/qrcode/unikey")) {
          return eapiResponse({ code: 200, unikey: "KEY-123" });
        }
        if (url.includes("/eapi/login/qrcode/client/login")) {
          return eapiResponse({ code: 801 });
        }
        throw new Error(`不该请求 ${url}`);
      }),
    );

    const client = new NeteaseClient();
    const qr = await client.createQR();

    expect(qr.key).toBe("KEY-123");
    // 二维码本地渲染成 SVG，不再去网易云取图。
    expect(qr.imageDataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);

    // 登录必须走 eapi（interface 域名 + /eapi/ 前缀），不能退回 weapi：
    // weapi 的 key 在手机客户端侧没有记录，扫码结果无处可写。
    const unikey = calls.find((call) => call.url.includes("/eapi/login/qrcode/unikey"));
    expect(unikey).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/weapi/"))).toBe(false);
    // 也不该再去抓图片 CDN。
    expect(calls).toHaveLength(1);

    // 请求体必须带 e_r 与设备 header：缺 e_r 上游会回明文，登录就废了。
    const payload = decodeEapiParams(unikey?.body ?? "");
    expect(payload.e_r).toBe(true);
    expect(payload.type).toBe(3);
    const header = payload.header as Record<string, unknown>;
    expect(header.os).toBe("pc");
    expect(header.appver).toBe("3.1.19.204510");
    expect(header.osver).toContain("Windows");

    // 要装成网易云桌面客户端，并带上设备四件套。
    expect(unikey?.headers["User-Agent"]).toContain("NeteaseMusicDesktop");
    expect(unikey?.headers.Cookie).toContain("appver=3.1.19.204510");

    const state = await client.checkQR(qr.key);
    expect(state.state).toBe("waiting");
  });

  it("also accepts a plaintext eapi response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 200, unikey: "KEY-PLAIN" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const client = new NeteaseClient();
    const qr = await client.createQR();
    expect(qr.key).toBe("KEY-PLAIN");
  });

  it("reports a response that is neither cipher nor JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json at all", { status: 200 })),
    );

    const client = new NeteaseClient();
    await expect(client.createQR()).rejects.toThrow(/密文/u);
  });

  it("maps the login status codes and keeps MUSIC_U", async () => {
    let loginCode = 801;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/eapi/login/qrcode/unikey")) {
          return eapiResponse({ code: 200, unikey: "KEY-123" });
        }
        return new Response(
          aes128EcbEncrypt(
            new TextEncoder().encode(EAPI_KEY),
            new TextEncoder().encode(JSON.stringify({ code: loginCode })),
          ),
          {
            status: 200,
            headers:
              loginCode === 803 ? { "set-cookie": "MUSIC_U=abc%2Cdef%3D; Path=/" } : {},
          },
        );
      }),
    );

    const client = new NeteaseClient();
    await client.createQR();

    loginCode = 802;
    expect((await client.checkQR("KEY-123")).state).toBe("scanned");

    loginCode = 800;
    expect((await client.checkQR("KEY-123")).state).toBe("expired");

    loginCode = 803;
    const success = await client.checkQR("KEY-123");
    expect(success.state).toBe("success");
    expect(success.state === "success" && success.cookies).toContain("MUSIC_U=abc%2Cdef%3D");
  });

  it("整个扫码会话用同一个设备标识", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          body: String(init?.body ?? ""),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (url.includes("/eapi/login/qrcode/unikey")) {
          return eapiResponse({ code: 200, unikey: "KEY-123" });
        }
        return eapiResponse({ code: 801 });
      }),
    );

    const client = new NeteaseClient();
    const qr = await client.createQR();
    await client.checkQR(qr.key);

    const unikey = calls.find((call) => call.url.includes("/eapi/login/qrcode/unikey"));
    const poll = calls.find((call) => call.url.includes("/eapi/login/qrcode/client/login"));
    expect(unikey).toBeTruthy();
    expect(poll).toBeTruthy();

    // 设备标识（deviceId）就是网易云眼里的「客户端身份」：取 key 与轮询必须是
    // 同一个，否则上游认不出这次扫码，状态会从「已扫码」退回「等待扫码」。
    const deviceId = (decodeEapiParams(unikey?.body ?? "").header as Record<string, unknown>)
      .deviceId;
    expect(deviceId).toMatch(/^[0-9A-F]{52}$/u);
    expect(
      (decodeEapiParams(poll?.body ?? "").header as Record<string, unknown>).deviceId,
    ).toBe(deviceId);
    // Cookie 头里也要带上同一个标识。
    expect(unikey?.headers.Cookie).toContain(`deviceId=${String(deviceId)}`);
    expect(poll?.headers.Cookie).toContain(`deviceId=${String(deviceId)}`);
  });
});
