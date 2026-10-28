import { afterEach, describe, expect, it, vi } from "vitest";
import { QQClient } from "../src/qq/client";
import { NeteaseClient } from "../src/netease/client";
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

describe("NetEase QR", () => {
  it("asks the web player for the QR image and inlines it", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.includes("/weapi/login/qrcode/unikey")) {
          return new Response(JSON.stringify({ unikey: "KEY-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/api/web/qrcode/get")) {
          return new Response(
            JSON.stringify({
              qrcodeImageUrl: "https://p6.music.126.net/obj/x/MUSICabc.jpg",
              code: 200,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/weapi/login/qrcode/client/login")) {
          return new Response(JSON.stringify({ code: 801 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JPEG_BYTES, { status: 200 });
      }),
    );

    const client = new NeteaseClient();
    const qr = await client.createQR();

    expect(qr.key).toBe("KEY-123");
    expect(qr.imageDataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);

    // 二维码内容仍然是 codekey 登录页，不能换成别的地址。
    const request = calls.find((call) => call.url.includes("/api/web/qrcode/get"));
    expect(request?.body).toContain("url=https%3A%2F%2Fmusic.163.com%2Flogin%3Fcodekey%3DKEY-123");

    const state = await client.checkQR(qr.key);
    expect(state.state).toBe("waiting");
  });

  it("refuses a QR image hosted outside NetEase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/weapi/login/qrcode/unikey")) {
          return new Response(JSON.stringify({ unikey: "KEY-123" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ qrcodeImageUrl: "https://evil.example.com/qr.jpg", code: 200 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const client = new NeteaseClient();
    await expect(client.createQR()).rejects.toThrow(/二维码/u);
  });
});
