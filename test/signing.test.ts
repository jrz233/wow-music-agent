/**
 * 两端共享的签名向量。
 *
 * 这些值由 `internal/features/agent/sign_test.go` 生成并校验；任何一侧修改
 * canonical string 都会让这里失败。签名只验不改：seed 对应的公钥在 vector 里。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  canonicalPair,
  canonicalRequest,
  canonicalResponse,
  importPublicKey,
  sha256Hex,
  verify,
} from "../src/agent/signing";

interface Vector {
  publicKey: string;
  seed: string;
  request: {
    method: string;
    path: string;
    query: string;
    timestamp: string;
    nonce: string;
    body: string;
    canonical: string;
    signature: string;
  };
  pair: {
    method: string;
    path: string;
    query: string;
    timestamp: string;
    nonce: string;
    body: string;
    canonical: string;
    signature: string;
  };
  response: {
    status: number;
    body: string;
    requestNonce: string;
    canonical: string;
    signature: string;
  };
}

const vector = JSON.parse(readFileSync("testdata/signing-vectors.json", "utf8")) as Vector;

const encoder = new TextEncoder();

describe("shared signing vectors", () => {
  it("derives the expected seed length", () => {
    expect(base64UrlDecode(vector.seed).length).toBe(32);
    expect(base64UrlDecode(vector.publicKey).length).toBe(32);
  });

  it("hashes the body exactly like Go", async () => {
    expect(await sha256Hex(vector.request.body)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the request canonical string and signature", async () => {
    const canonical = await canonicalRequest(
      vector.request.method,
      vector.request.path,
      vector.request.query,
      vector.request.timestamp,
      vector.request.nonce,
      encoder.encode(vector.request.body),
    );
    expect(canonical).toBe(vector.request.canonical);
    const key = await importPublicKey(base64UrlDecode(vector.publicKey));
    expect(await verify(key, canonical, vector.request.signature)).toBe(true);
    expect(await verify(key, `${canonical}\n`, vector.request.signature)).toBe(false);
  });

  it("matches the pairing canonical string and signature", async () => {
    const canonical = await canonicalPair(
      vector.pair.method,
      vector.pair.path,
      vector.pair.query,
      vector.pair.timestamp,
      vector.pair.nonce,
      encoder.encode(vector.pair.body),
    );
    expect(canonical).toBe(vector.pair.canonical);
    const key = await importPublicKey(base64UrlDecode(vector.publicKey));
    expect(await verify(key, canonical, vector.pair.signature)).toBe(true);
  });

  it("matches the response canonical string and signature", async () => {
    const canonical = await canonicalResponse(
      vector.response.status,
      encoder.encode(vector.response.body),
      vector.response.requestNonce,
    );
    expect(canonical).toBe(vector.response.canonical);
    const key = await importPublicKey(base64UrlDecode(vector.publicKey));
    expect(await verify(key, canonical, vector.response.signature)).toBe(true);
  });

  it("normalizes query the same way on both sides", async () => {
    // 同名键排序、+ 当空格、空格编码 %20。
    const canonical = await canonicalRequest(
      "GET",
      "/v1/x",
      "b=2&a=z+z&a=%20x",
      "1700000000",
      "00112233445566778899aabbccddeeff",
      new Uint8Array(),
    );
    const lines = canonical.split("\n");
    expect(lines[3]).toBe("a=%20x&a=z%20z&b=2");
  });
});
