/**
 * `/v1` 双向签名的端到端单元测试：不依赖网络与真实 Durable Object。
 * 验证 200 响应签名、nonce 重放、query 篡改与平台未登录的签名错误响应。
 */

import { describe, expect, it } from "vitest";
import type { AgentIdentity } from "../src/agent/oauth";
import type { AgentStore } from "../src/agent/store";
import { createV1App } from "../src/agent/v1";
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalRequest,
  canonicalResponse,
  generateSigningKey,
  HEADER_AGENT_ID,
  HEADER_NONCE,
  HEADER_RESPONSE_SIGNATURE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  importPrivateKey,
  importPublicKey,
  keyFingerprint,
  newNonce,
  sign,
  verify,
} from "../src/agent/signing";

const AGENT_ID = "agent-0123456789abcdef";

async function fixtures() {
  const server = await generateSigningKey();
  const agent = await generateSigningKey();
  const agentIdentity: AgentIdentity = {
    publicKey: base64UrlEncode(agent.publicKey),
    publicKeyRaw: agent.publicKey,
    privateKey: await importPrivateKey(agent.privateKeyPkcs8),
    fingerprint: await keyFingerprint(agent.publicKey),
  };
  const seen = new Set<string>();
  const store = {
    agent: () => ({
      agentId: AGENT_ID,
      serverUrl: "https://wow.example",
      serverPublicKey: base64UrlEncode(server.publicKey),
      publicKey: agentIdentity.publicKey,
      accountName: "测试账号",
      pairedAt: 1,
      lastSeenAt: 1,
    }),
    useNonce: (scope: string, nonce: string) => {
      const key = `${scope}:${nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    touchAgent: () => undefined,
    platform: () => null,
  } as unknown as AgentStore;

  return {
    server,
    agentIdentity,
    app: createV1App(store, agentIdentity),
  };
}

async function signedRequest(
  serverPrivateKey: CryptoKey,
  options: { path?: string; query?: string; nonce?: string; timestamp?: string } = {},
): Promise<Request> {
  const path = options.path ?? "/v1/status";
  const query = options.query ?? "";
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? newNonce();
  const canonical = await canonicalRequest("GET", path, query, timestamp, nonce, new Uint8Array());
  const signature = await sign(serverPrivateKey, canonical);
  return new Request(`https://agent.example${path}${query ? `?${query}` : ""}`, {
    headers: {
      [HEADER_AGENT_ID]: AGENT_ID,
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_NONCE]: nonce,
      [HEADER_SIGNATURE]: signature,
    },
  });
}

describe("v1 signed requests", () => {
  it("accepts a valid request and signs the response", async () => {
    const { server, agentIdentity, app } = await fixtures();
    const request = await signedRequest(await importPrivateKey(server.privateKeyPkcs8));
    const nonce = request.headers.get(HEADER_NONCE) ?? "";
    const response = await app.fetch(request);
    expect(response.status).toBe(200);

    const body = new Uint8Array(await response.arrayBuffer());
    const signature = response.headers.get(HEADER_RESPONSE_SIGNATURE) ?? "";
    const canonical = await canonicalResponse(200, body, nonce);
    const publicKey = await importPublicKey(base64UrlDecode(agentIdentity.publicKey));
    expect(await verify(publicKey, canonical, signature)).toBe(true);

    const payload = JSON.parse(new TextDecoder().decode(body)) as {
      apiVersion: number;
      platforms: { qq: { loggedIn: boolean } };
    };
    expect(payload.apiVersion).toBe(1);
    expect(payload.platforms.qq.loggedIn).toBe(false);
  });

  it("rejects a replayed nonce", async () => {
    const { server, app } = await fixtures();
    const nonce = "00112233445566778899aabbccddeeff";
    const signer = await importPrivateKey(server.privateKeyPkcs8);
    const first = await signedRequest(signer, { nonce });
    expect((await app.fetch(first)).status).toBe(200);
    const second = await signedRequest(signer, { nonce });
    expect((await app.fetch(second)).status).toBe(401);
  });

  it("rejects a signed path that does not match the URL", async () => {
    const { server, app } = await fixtures();
    const request = await signedRequest(await importPrivateKey(server.privateKeyPkcs8));
    const tampered = new Request(`${request.url}?platform=qq`, { headers: request.headers });
    expect((await app.fetch(tampered)).status).toBe(401);
  });

  it("rejects stale timestamps", async () => {
    const { server, app } = await fixtures();
    const request = await signedRequest(await importPrivateKey(server.privateKeyPkcs8), {
      timestamp: String(Math.floor(Date.now() / 1000) - 120),
    });
    expect((await app.fetch(request)).status).toBe(401);
  });

  it("returns a signed 409 when the platform is not logged in", async () => {
    const { server, agentIdentity, app } = await fixtures();
    const signer = await importPrivateKey(server.privateKeyPkcs8);
    const nonce = newNonce();
    const query = "limit=10&platform=qq";
    const request = await signedRequest(signer, {
      path: "/v1/library/playlists",
      query,
      nonce,
    });
    const response = await app.fetch(request);
    expect(response.status).toBe(409);
    const body = new Uint8Array(await response.arrayBuffer());
    const signature = response.headers.get(HEADER_RESPONSE_SIGNATURE) ?? "";
    const publicKey = await importPublicKey(base64UrlDecode(agentIdentity.publicKey));
    expect(
      await verify(publicKey, await canonicalResponse(409, body, nonce), signature),
    ).toBe(true);
  });

  it("rejects missing signature headers", async () => {
    const { app } = await fixtures();
    const response = await app.fetch(new Request("https://agent.example/v1/status"));
    expect(response.status).toBe(401);
    expect(response.headers.get(HEADER_RESPONSE_SIGNATURE)).toBeNull();
  });

  it("advertises the library snapshot capability in status", async () => {
    const { server, app } = await fixtures();
    const request = await signedRequest(await importPrivateKey(server.privateKeyPkcs8));
    const response = await app.fetch(request);
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()))) as {
      capabilities: string[];
    };
    expect(payload.capabilities).toContain("library.snapshot");
  });

  it("returns a signed snapshot with per-platform errors when logged out", async () => {
    const { server, agentIdentity, app } = await fixtures();
    const signer = await importPrivateKey(server.privateKeyPkcs8);
    const nonce = newNonce();
    const query = "ids=abc%2Cdef&limit=50&platform=all&trackLimit=200";
    const request = await signedRequest(signer, {
      path: "/v1/library/snapshot",
      query,
      nonce,
    });
    const response = await app.fetch(request);
    expect(response.status).toBe(200);

    const body = new Uint8Array(await response.arrayBuffer());
    const signature = response.headers.get(HEADER_RESPONSE_SIGNATURE) ?? "";
    const publicKey = await importPublicKey(base64UrlDecode(agentIdentity.publicKey));
    expect(
      await verify(publicKey, await canonicalResponse(200, body, nonce), signature),
    ).toBe(true);

    const payload = JSON.parse(new TextDecoder().decode(body)) as {
      platforms: Record<string, { playlists: unknown[]; details: unknown[]; error: string }>;
    };
    // 两个平台都没登录：各自带错误，但整体仍是 200，服务端据此跳过该平台。
    const qq = payload.platforms["qq"];
    const netease = payload.platforms["netease"];
    expect(qq?.error).toBe("平台尚未登录");
    expect(netease?.error).toBe("平台尚未登录");
    expect(qq?.playlists).toEqual([]);
  });
});
