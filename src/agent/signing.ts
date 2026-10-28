/**
 * 双向签名的 TypeScript 侧实现。
 *
 * canonical string 必须与 wow-server `internal/features/agent/sign.go` **逐字一致**。
 * 固定向量在 `agent/testdata/signing-vectors.json`，Go 与 TS 测试都跑同一份。
 */

export const HEADER_AGENT_ID = "X-Wow-Agent-Id";
export const HEADER_PAIRING_ID = "X-Wow-Pairing-Id";
export const HEADER_TIMESTAMP = "X-Wow-Timestamp";
export const HEADER_NONCE = "X-Wow-Nonce";
export const HEADER_SIGNATURE = "X-Wow-Signature";
export const HEADER_RESPONSE_SIGNATURE = "X-Wow-Response-Signature";

/** 与 Go 的 `SignatureWindow` 对齐。 */
export const SIGNATURE_WINDOW_SECONDS = 60;

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

export function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new Error("invalid hex");
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export async function bodyHash(body: Uint8Array): Promise<string> {
  return sha256Hex(body);
}

/** RFC 3986：只保留 `A-Za-z0-9-._~`，其余按 UTF-8 字节写成大写 `%XX`。 */
export function percentEncode(value: string): string {
  const bytes = utf8(value);
  const upperHex = "0123456789ABCDEF";
  let result = "";
  for (const byte of bytes) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    if (isUnreserved) {
      result += String.fromCharCode(byte);
    } else {
      result += `%${upperHex[byte >> 4]}${upperHex[byte & 0x0f]}`;
    }
  }
  return result;
}

/**
 * 归一化 query。与 Go `url.ParseQuery` 的语义保持一致：
 * `+` 当空格、百分号解码、同名键保留全部值；解析失败时退回原始串（让签名自然不匹配）。
 */
export function canonicalQuery(rawQuery: string): string {
  if (rawQuery === "") {
    return "";
  }
  let pairs: [string, string][];
  try {
    pairs = parseQuery(rawQuery);
  } catch {
    return rawQuery;
  }
  const grouped = new Map<string, string[]>();
  for (const [key, value] of pairs) {
    const list = grouped.get(key);
    if (list) {
      list.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }
  const keys = [...grouped.keys()].sort(compareUtf8);
  const parts: string[] = [];
  for (const key of keys) {
    const values = grouped.get(key);
    if (!values) continue;
    values.sort(compareUtf8);
    for (const value of values) {
      parts.push(`${percentEncode(key)}=${percentEncode(value)}`);
    }
  }
  return parts.join("&");
}

/** Go 的 sort.Strings 按 UTF-8 字节序比较；默认 JS sort 按 UTF-16 code unit，补上差异。 */
function compareUtf8(left: string, right: string): number {
  const a = utf8(left);
  const b = utf8(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
}

function parseQuery(rawQuery: string): [string, string][] {
  const result: [string, string][] = [];
  for (const pair of rawQuery.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const rawKey = index < 0 ? pair : pair.slice(0, index);
    const rawValue = index < 0 ? "" : pair.slice(index + 1);
    result.push([queryUnescape(rawKey), queryUnescape(rawValue)]);
  }
  return result;
}

function queryUnescape(value: string): string {
  const replaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(replaced);
  } catch {
    throw new Error("invalid escape");
  }
}

export function canonicalRequest(
  method: string,
  path: string,
  rawQuery: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
): Promise<string> {
  return bodyHash(body).then((hash) =>
    [
      "WOW-AGENT-REQUEST-V1",
      method.toUpperCase(),
      path,
      canonicalQuery(rawQuery),
      timestamp,
      nonce,
      hash,
    ].join("\n"),
  );
}

export function canonicalPair(
  method: string,
  path: string,
  rawQuery: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
): Promise<string> {
  return bodyHash(body).then((hash) =>
    [
      "WOW-PAIR-V1",
      method.toUpperCase(),
      path,
      canonicalQuery(rawQuery),
      timestamp,
      nonce,
      hash,
    ].join("\n"),
  );
}

export function canonicalResponse(
  status: number,
  body: Uint8Array,
  requestNonce: string,
): Promise<string> {
  return bodyHash(body).then((hash) =>
    ["WOW-AGENT-RESPONSE-V1", String(status), hash, requestNonce].join("\n"),
  );
}

// ---- Ed25519 ---------------------------------------------------------------

export interface SigningKeyPair {
  publicKey: Uint8Array;
  privateKeyPkcs8: Uint8Array;
}

export async function generateSigningKey(): Promise<SigningKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const privateKeyPkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  return { publicKey, privateKeyPkcs8 };
}

export async function importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

export async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

export async function sign(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, utf8(message));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function verify(
  publicKey: CryptoKey,
  message: string,
  signature: string,
): Promise<boolean> {
  let raw: Uint8Array;
  try {
    raw = base64UrlDecode(signature);
  } catch {
    return false;
  }
  if (raw.length !== 64) {
    return false;
  }
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, raw, utf8(message));
  } catch {
    return false;
  }
}

export async function keyFingerprint(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  return toHex(digest.slice(0, 16));
}

// ---- 时间窗与 nonce ---------------------------------------------------------

export function isValidTimestamp(raw: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!/^\d{1,12}$/u.test(raw)) {
    return false;
  }
  const value = Number.parseInt(raw, 10);
  return Math.abs(nowSeconds - value) <= SIGNATURE_WINDOW_SECONDS;
}

export function isValidNonce(nonce: string): boolean {
  return /^[0-9a-f]{16,128}$/u.test(nonce);
}

export function newNonce(): string {
  const buffer = new Uint8Array(16);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}
