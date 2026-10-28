/**
 * 网易云风控令牌（`x-anticheattoken`）。
 *
 * 上游对少数接口（Personal FM 等）会校验这个头：缺失或格式不对，会被当成爬虫直接
 * 拒绝。算法与 wow-origin 的 `platforms/netease/util/checkToken.js` 一致：
 *
 * 1. 把「当前时间 + 8 字节随机数」编成一个 16 字节的块；
 * 2. 用固定盐对该块的十六进制做 MD5，取前 8 字节拼在块前面；
 * 3. 整体 base64（无 padding）；
 * 4. 再用固定 6 字节密钥逐字节异或并取补码，输出小写 hex。
 *
 * **只用于协议兼容**：它不是凭据，也不参与任何安全判断。
 */

import { md5 } from "./md5";

const SALT = "dAWsBhCqtOaNLLJ25hBzWbqWXwiK99Wd";

/** 异或密钥（来自上游客户端的常量表）。 */
const XOR_KEY = new Uint8Array([0x1f, 0x7d, 0xf4, 0x3c, 0x20, 0x30]);

/** 两种协议各有一份设备指纹。 */
const DEVICE_ID = {
  weapi: "dyRmOyIM4HJEUVQUVBLGhjpWetksmiyy",
  eapi: "jiEABHxUxtVBFBVEQFKSgnoWYHsMEqAV",
} as const;

export type CheckTokenKind = keyof typeof DEVICE_ID;

export interface CheckTokenOptions {
  /** 毫秒时间戳；默认当前时间。测试里固定它才能比对向量。 */
  now?: number;
  /** 8 字节随机数；默认取随机。 */
  random?: Uint8Array;
}

/** 生成 `x-anticheattoken` 的值（小写 hex）。 */
export function checkToken(kind: CheckTokenKind, options: CheckTokenOptions = {}): string {
  const payload = JSON.stringify({
    r: 1,
    d: DEVICE_ID[kind],
    b: block(options),
  });
  return transform(payload);
}

/** 第 2、3 步：时间随机块 → base64。 */
function block(options: CheckTokenOptions): string {
  const now = options.now ?? Date.now();
  const random = options.random ?? crypto.getRandomValues(new Uint8Array(8));
  const e = makeE(now, random);
  const digest = md5(new TextEncoder().encode(`${toHex(e)}${SALT}`));
  const head = fromHex(digest.slice(0, 16));
  return base64(concat(head, e));
}

/** 第 1 步：把「时间 + 随机数」摊成 16 字节。 */
function makeE(now: number, random: Uint8Array): Uint8Array {
  const hi = Math.floor(now / 0x1_0000_0000) >>> 0;
  const lo = (now % 0x1_0000_0000) >>> 0;
  const counter = new Uint8Array(8);
  counter[0] = (hi >>> 24) & 0xff;
  counter[1] = (hi >>> 16) & 0xff;
  counter[2] = (hi >>> 8) & 0xff;
  counter[3] = hi & 0xff;
  counter[4] = (lo >>> 24) & 0xff;
  counter[5] = (lo >>> 16) & 0xff;
  counter[6] = (lo >>> 8) & 0xff;
  counter[7] = lo & 0xff;

  const rand = random.length >= 8 ? random.slice(0, 8) : new Uint8Array(8);
  const out = new Uint8Array(16);
  for (let position = 0; position < 16; position += 1) {
    const group = position >> 1;
    if ((position & 1) === 0) {
      // 偶数位：高半 nibble
      out[position] =
        ((rand[group]! & 0x10) >>> 4) |
        ((rand[group]! & 0x20) >>> 3) |
        ((rand[group]! & 0x40) >>> 2) |
        ((rand[group]! & 0x80) >>> 1) |
        ((counter[group]! & 0x10) >>> 3) |
        ((counter[group]! & 0x20) >>> 2) |
        ((counter[group]! & 0x40) >>> 1) |
        ((counter[group]! & 0x80) >>> 0);
    } else {
      // 奇数位：低半 nibble
      out[position] =
        ((rand[group]! & 0x01) << 0) |
        ((rand[group]! & 0x02) << 1) |
        ((rand[group]! & 0x04) << 2) |
        ((rand[group]! & 0x08) << 3) |
        ((counter[group]! & 0x01) << 1) |
        ((counter[group]! & 0x02) << 2) |
        ((counter[group]! & 0x04) << 3) |
        ((counter[group]! & 0x08) << 4);
    }
  }
  return out;
}

/** 第 4 步：逐字节异或并取补码，输出小写 hex。 */
function transform(value: string): string {
  const input = percentToBytes(value);
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const mixed = (input[index]! ^ XOR_KEY[index % XOR_KEY.length]!) & 0xff;
    output[index] = (256 - mixed) & 0xff;
  }
  return toHex(output);
}

/** 把可能带 `%xx` 的字符串还原成字节。 */
function percentToBytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "%" && index + 2 < value.length) {
      const parsed = Number.parseInt(value.slice(index + 1, index + 3), 16);
      if (!Number.isNaN(parsed)) {
        out.push(parsed & 0xff);
        index += 2;
        continue;
      }
    }
    out.push(value.charCodeAt(index) & 0xff);
  }
  return Uint8Array.from(out);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** base64（无 padding）。 */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=+$/u, "");
}
