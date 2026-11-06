import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { checkToken } from "../src/netease/checktoken";
import { neteaseLoginURL, qrCodeDataUrl } from "../src/netease/qr";

/** 参考实现（wow-origin `platforms/netease/util/checkToken.js`）的固定向量。 */
const FIXED_NOW = 1_700_000_000_000;
const FIXED_RANDOM = Uint8Array.from({ length: 8 }, (_, index) => index + 1);

describe("网易云风控令牌", () => {
  it("与参考实现逐字一致（eapi）", () => {
    expect(checkToken("eapi", { now: FIXED_NOW, random: FIXED_RANDOM })).toBe(
      "9ca17ae2e6ffcda170e2e6ee8bec4f839e8899d874b88a8ea7c15e878f8aacd26daeb199bacb798f9bbfa2d52af0feaec3b92a94aafad5f37aa1ee87a2b74b838f8fa6c44ba79fa392c23db39c9790ef5b829fee9e",
    );
  });

  it("与参考实现逐字一致（weapi）", () => {
    expect(checkToken("weapi", { now: FIXED_NOW, random: FIXED_RANDOM })).toBe(
      "9ca17ae2e6ffcda170e2e6ee85fc5aaf91b7aad0408c968bb6d55b978a8eadc664aab09986f761b1b3a79afc2af0feaec3b92a94aafad5f37aa1ee87a2b74b838f8fa6c44ba79fa392c23db39c9790ef5b829fee9e",
    );
  });

  it("每次调用都不一样（带随机数与时间）", () => {
    const first = checkToken("eapi");
    const second = checkToken("eapi");
    expect(first).toMatch(/^[0-9a-f]+$/u);
    expect(first).not.toBe(second);
  });
});

describe("网易云二维码", () => {
  it("内容是 codekey 登录页", () => {
    expect(neteaseLoginURL("KEY-123")).toBe(
      "https://music.163.com/login?codekey=KEY-123",
    );
  });

  it("渲染成 SVG，模块数与编码器一致", () => {
    const url = neteaseLoginURL("KEY-123");
    const dataUrl = qrCodeDataUrl(url);
    expect(dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);

    const svg = atob(dataUrl.slice("data:image/svg+xml;base64,".length));
    expect(svg.startsWith("<svg")).toBe(true);

    const modules = QRCode.create(url, { errorCorrectionLevel: "H" }).modules;
    // 每一个深色模块对应路径里的一段。
    const dark = modules.data.reduce((count, value) => count + (value ? 1 : 0), 0);
    expect(svg.match(/h1v1h-1z/gu)?.length ?? 0).toBe(dark);
    expect(svg).toContain(`viewBox="0 0 ${modules.size + 2} ${modules.size + 2}"`);
  });
});
