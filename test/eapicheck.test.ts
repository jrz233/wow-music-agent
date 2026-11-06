import { describe, expect, it } from "vitest";
import { createCipheriv } from "node:crypto";
import { eapiParams, eapiDecrypt } from "../src/netease/crypto";

describe("eapi", () => {
  it("unikey 请求与参考实现逐字一致", async () => {
    const reference =
      "1CA81A97B7BAEB099F29A9B99A25CD6E58E7BA5B35F25231033065C776830C0A38A128CF8B3EAF44635E50E0B9800A4A037CBDA1E04BD460C02768E3ECD5E66E905A5BCAE52009FB0933EFB373A62E834048DEBDABCCC627F25820A8D94E0A8C";
    expect(eapiParams("/api/login/qrcode/unikey", { type: 3 })).toBe(reference);
  });

  it("能解开 eapi 响应体", async () => {
    const plain = JSON.stringify({ code: 200, unikey: "abc" });
    const cipher = createCipheriv("aes-128-ecb", Buffer.from("e82ckenh8dichen8"), Buffer.alloc(0));
    const encrypted = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
    expect(eapiDecrypt(new Uint8Array(encrypted))).toBe(plain);
  });
});
