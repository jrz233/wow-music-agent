/**
 * Durable Object 内的加密原语。
 *
 * 设计目标：**用户不需要配置任何密钥**。
 *   - 首次启动生成 32 字节 master key，存在 DO 的 SQLite 里；
 *   - 平台会话（Cookie）用 HKDF-SHA256 派生出的 AES-256-GCM 密钥加密，AAD 绑定
 *     `platform + userId`，防止把 A 账号的密文挪到 B 账号下解出；
 *   - Agent 自己的 Ed25519 私钥用同一 master key 加密后落库。
 *
 * DO SQLite 本身由 Cloudflare 加密存储；这里再加一层，保证备份/调试导出里没有明文凭据。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  return buffer;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

export function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** 32 字节随机 master key（base64）。 */
export function createMasterKey(): string {
  return toBase64(randomBytes(32));
}

async function deriveKey(
  masterKeyBase64: string,
  info: string,
  salt: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const master = fromBase64(masterKeyBase64);
  if (master.length !== 32) {
    throw new Error("master key 长度错误");
  }
  const baseKey = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      info: encoder.encode(info),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** 密文形状：`v1:<base64(iv)>:<base64(ciphertext)>`。 */
export async function seal(
  masterKeyBase64: string,
  plaintext: string,
  aad: string,
  salt: string,
): Promise<string> {
  const key = await deriveKey(masterKeyBase64, "wow-agent-storage-v1", salt, "encrypt");
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      key,
      encoder.encode(plaintext),
    ),
  );
  return `v1:${toBase64(iv)}:${toBase64(ciphertext)}`;
}

export async function open(
  masterKeyBase64: string,
  sealed: string,
  aad: string,
  salt: string,
): Promise<string> {
  const parts = sealed.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("密文格式错误");
  }
  const key = await deriveKey(masterKeyBase64, "wow-agent-storage-v1", salt, "decrypt");
  const iv = fromBase64(parts[1] ?? "");
  const ciphertext = fromBase64(parts[2] ?? "");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    ciphertext,
  );
  return decoder.decode(plaintext);
}

/** 平台会话的 AAD / salt：绑定平台与平台用户 id。 */
export function platformAAD(platform: string, userId: string): string {
  return `platform/${platform}/${userId}`;
}
