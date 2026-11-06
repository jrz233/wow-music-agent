import { describe, expect, it } from "vitest";
import { aes128EcbEncrypt, aes128EcbDecrypt } from "../src/netease/aes";
import { createCipheriv, createDecipheriv } from "node:crypto";

const key = Buffer.from("e82ckenh8dichen8");
const enc = (text: string) => {
  const cipher = createCipheriv("aes-128-ecb", key, Buffer.alloc(0));
  return Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final()]);
};

describe("aes128Ecb", () => {
  it("FIPS-197 附录 B 向量：AES-128 分组", () => {
    const k = Uint8Array.from(Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex"));
    const plain = Uint8Array.from(Buffer.from("3243f6a8885a308d313198a2e0370734", "hex"));
    const expectCipher = Buffer.from("3925841d02dc09fbdc118597196a0b32", "hex");
    const out = aes128EcbEncrypt(k, plain);
    // 单块明文也要填充，所以取前 16 字节比对
    expect(Buffer.from(out.subarray(0, 16)).toString("hex")).toBe(expectCipher.toString("hex"));
  });

  it("与 node:crypto 的 AES-128-ECB 逐字节一致", () => {
    for (const text of ["", "a", "hello world", "中文测试内容", "x".repeat(100)]) {
      const ours = Buffer.from(aes128EcbEncrypt(key, Buffer.from(text, "utf8"))).toString("hex");
      expect(ours).toBe(enc(text).toString("hex"));
    }
  });

  it("往返", () => {
    const text = "往返测试 abc 123";
    const cipher = aes128EcbEncrypt(key, Buffer.from(text, "utf8"));
    expect(Buffer.from(aes128EcbDecrypt(key, cipher)).toString("utf8")).toBe(text);
  });

  it("能解开 node:crypto 产生的密文", () => {
    const cipher = enc("来自 node 的密文");
    expect(Buffer.from(aes128EcbDecrypt(key, cipher)).toString("utf8")).toBe("来自 node 的密文");
  });
});
