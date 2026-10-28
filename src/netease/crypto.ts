/**
 * 网易云 weapi 加密。
 *
 * 平台网页端用 AES-CBC(两层) + RSA(只有公钥) 把参数包成 `params` / `encSecKey`。
 * 这里用 WebCrypto 做 AES、用 BigInt 做 RSA（1024-bit 模幂，参数很小，固定公钥，
 * 不需要私钥，因此不必引入 crypto.subtle 的 RSA importKey/DER 处理）。
 */

import { aes128EcbDecrypt, aes128EcbEncrypt } from "./aes";
import { md5 } from "./md5";

const PRESET_KEY = "0CoJUm6Qyw8W8jud";
const IV = "0102030405060708";
const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MODULUS =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
const PUBLIC_EXPONENT = 0x10001n;

const encoder = new TextEncoder();
const MODULUS_BIGINT = BigInt(`0x${MODULUS}`);

export function randomSecretKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let result = "";
  for (const byte of bytes) {
    result += BASE62[byte % BASE62.length];
  }
  return result;
}

export async function aesEncrypt(text: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: encoder.encode(IV) },
    cryptoKey,
    encoder.encode(text),
  );
  return base64(new Uint8Array(ciphertext));
}

/** 仅测试使用：验证两层 AES 的往返。 */
export async function aesDecrypt(ciphertextBase64: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: encoder.encode(IV) },
    cryptoKey,
    fromBase64(ciphertextBase64),
  );
  return new TextDecoder().decode(plaintext);
}

/** 把 16 字符密钥按字节逆序解释成大端整数，再做 RSA 公钥运算。 */
export function rsaEncrypt(secretKey: string): string {
  let hex = "";
  for (let index = secretKey.length - 1; index >= 0; index -= 1) {
    hex += secretKey.charCodeAt(index).toString(16).padStart(2, "0");
  }
  const message = BigInt(`0x${hex}`);
  const encrypted = modPow(message, PUBLIC_EXPONENT, MODULUS_BIGINT);
  return encrypted.toString(16).padStart(256, "0");
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) {
      result = (result * value) % modulus;
    }
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

export interface WeapiPayload {
  params: string;
  encSecKey: string;
}

export async function weapi(payload: Record<string, unknown>): Promise<WeapiPayload> {
  const text = JSON.stringify(payload);
  const first = await aesEncrypt(text, PRESET_KEY);
  const secretKey = randomSecretKey();
  const params = await aesEncrypt(first, secretKey);
  return { params, encSecKey: rsaEncrypt(secretKey) };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

/* ══════════════════════════════ eapi ══════════════════════════════
 *
 * 登录链路必须用 eapi，不能用 weapi。
 *
 * 实测：`POST /weapi/login/qrcode/unikey` 能出一个 key，也能出二维码图，手机扫完
 * 也提示成功，但 `login/qrcode/client/login` 永远停在 801（等待扫码）——手机端
 * 认的是 **eapi** 的会话，weapi 那一路的 key 在客户端侧没有对应记录，于是扫码
 * 结果无处可写。参考实现（wow-origin `platforms/netease/module/login_qr_*.js`）
 * 用的正是 eapi + `type: 3`。
 *
 * eapi 与 weapi 的差别：
 *   - 固定密钥 AES-128-**ECB**（无 IV），输出 **大写 HEX**；
 *   - 明文是 `<url>-36cd479b6b5-<json>-36cd479b6b5-<md5("nobody"+url+"use"+json+"md5forencrypt")>`；
 *   - 打到 `https://interface.music.163.com/eapi/<去掉 /api 前缀的路径>`；
 *   - 响应体也是同一密钥的 ECB 密文，要解密后才能当 JSON 读。
 */

const EAPI_KEY = "e82ckenh8dichen8";
const EAPI_PAD = "-36cd479b6b5-";
const EAPI_HOST = "https://interface.music.163.com";

/** eapi 请求体：`params=<大写 HEX>`。 */
export function eapiParams(path: string, payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  const digest = md5Hex(`nobody${path}use${text}md5forencrypt`);
  return aesEcbHex(`${path}${EAPI_PAD}${text}${EAPI_PAD}${digest}`);
}

/** 解 eapi 响应体（密文是原始字节，不是 HEX 文本）。 */
export function eapiDecrypt(bytes: Uint8Array): string {
  return new TextDecoder().decode(aes128EcbDecrypt(encoder.encode(EAPI_KEY), bytes));
}

/** eapi 路径：`/api/xxx` → `/eapi/xxx`。 */
export function eapiPath(path: string): string {
  const trimmed = path.startsWith("/api/") ? path.slice(4) : path.startsWith("/") ? path : `/${path}`;
  return `${EAPI_HOST}/eapi${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
}

function aesEcbHex(text: string): string {
  return hexUpper(aes128EcbEncrypt(encoder.encode(EAPI_KEY), encoder.encode(text)));
}

function md5Hex(text: string): string {
  return md5(encoder.encode(text));
}

function hexUpper(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result.toUpperCase();
}
