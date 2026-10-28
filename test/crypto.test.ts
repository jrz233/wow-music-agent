import { describe, expect, it } from "vitest";
import { createMasterKey, open, platformAAD, randomBytes, seal, toBase64 } from "../src/agent/crypto";
import { aesDecrypt, aesEncrypt, rsaEncrypt, weapi } from "../src/netease/crypto";

describe("storage encryption", () => {
  it("round-trips and binds AAD / salt", async () => {
    const master = createMasterKey();
    const aad = platformAAD("qq", "12345");
    const sealed = await seal(master, "uin=12345; qqmusic_key=secret", aad, aad);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("qqmusic_key");
    expect(await open(master, sealed, aad, aad)).toContain("qqmusic_key=secret");

    await expect(open(master, sealed, platformAAD("netease", "12345"), aad)).rejects.toThrow();
    await expect(open(master, sealed, aad, "other-salt")).rejects.toThrow();
    await expect(open(createMasterKey(), sealed, aad, aad)).rejects.toThrow();
  });

  it("generates a 32-byte master key", () => {
    expect(atob(createMasterKey()).length).toBe(32);
    expect(toBase64(randomBytes(16)).length).toBeGreaterThan(0);
  });
});

describe("netease weapi primitives", () => {
  it("AES-CBC encrypts and decrypts with the preset key", async () => {
    const plaintext = JSON.stringify({ uid: "1", limit: 100 });
    const ciphertext = await aesEncrypt(plaintext, "0CoJUm6Qyw8W8jud");
    expect(ciphertext).not.toBe(plaintext);
    expect(await aesDecrypt(ciphertext, "0CoJUm6Qyw8W8jud")).toBe(plaintext);
  });

  it("produces a fixed-width RSA block", () => {
    const block = rsaEncrypt("abcdefghijklmnop");
    expect(block).toMatch(/^[0-9a-f]{256}$/u);
    expect(block).toBe(rsaEncrypt("abcdefghijklmnop"));
    expect(block).not.toBe(rsaEncrypt("ponmlkjihgfedcba"));
  });

  it("wraps params into the two required fields", async () => {
    const payload = await weapi({ a: 1 });
    expect(payload.params).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(payload.encSecKey).toMatch(/^[0-9a-f]{256}$/u);
  });
});
