/**
 * AES-128 的 ECB 模式（PKCS#7 填充）。
 *
 * **为什么自己写**：网易云 eapi 用的是 AES-128-ECB，而 WebCrypto 的规范里根本没有
 * ECB（只有 CBC/CTR/GCM），Worker 里也没有 node:crypto 可退。eapi 的密钥是公开的
 * 固定值，用途只是让请求「像客户端」，**不承担任何机密性职责**——真正的凭据保护
 * 由 `agent/crypto.ts` 的 HKDF + AES-GCM 负责，那一层仍然走 WebCrypto。
 *
 * 实现是教科书版（SubBytes / ShiftRows / MixColumns / AddRoundKey），刻意不写
 * T-table 混淆：这段代码要能被逐行核对，而不是追求吞吐。
 */

/** 轮密钥：11 组 × 16 字节。 */
type RoundKeys = Uint8Array;

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

/** GF(2^8) 乘法，模 x^8+x^4+x^3+x+1。 */
function mul(a: number, b: number): number {
  let result = 0;
  let left = a;
  let right = b;
  for (let index = 0; index < 8; index += 1) {
    if (right & 1) result ^= left;
    const high = left & 0x80;
    left = (left << 1) & 0xff;
    if (high) left ^= 0x1b;
    right >>= 1;
  }
  return result;
}

export function aes128EcbEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error("AES-128 需要 16 字节密钥");
  const keys = expandKey(key);
  const padded = pad(plaintext);
  const output = new Uint8Array(padded.length);
  for (let offset = 0; offset < padded.length; offset += 16) {
    output.set(encryptBlock(keys, padded.subarray(offset, offset + 16)), offset);
  }
  return output;
}

export function aes128EcbDecrypt(key: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error("AES-128 需要 16 字节密钥");
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error("AES 密文长度必须是 16 的倍数");
  }
  const keys = expandKey(key);
  const output = new Uint8Array(ciphertext.length);
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    output.set(decryptBlock(keys, ciphertext.subarray(offset, offset + 16)), offset);
  }
  return unpad(output);
}

function pad(input: Uint8Array): Uint8Array {
  const remainder = input.length % 16;
  const extra = 16 - remainder;
  const output = new Uint8Array(input.length + extra);
  output.set(input);
  output.fill(extra, input.length);
  return output;
}

/** 严格校验填充：填充不合法说明密钥不对或密文被改过。 */
function unpad(input: Uint8Array): Uint8Array {
  const last = input[input.length - 1] ?? 0;
  if (last < 1 || last > 16 || last > input.length) {
    throw new Error("AES 填充不合法");
  }
  for (let index = input.length - last; index < input.length; index += 1) {
    if (input[index] !== last) throw new Error("AES 填充不合法");
  }
  return input.slice(0, input.length - last);
}

function expandKey(key: Uint8Array): RoundKeys {
  const expanded = new Uint8Array(176);
  expanded.set(key);
  let rconIndex = 0;
  for (let offset = 16; offset < 176; offset += 4) {
    let word0 = expanded[offset - 4]!;
    let word1 = expanded[offset - 3]!;
    let word2 = expanded[offset - 2]!;
    let word3 = expanded[offset - 1]!;
    if (offset % 16 === 0) {
      // RotWord + SubWord + Rcon
      const temp = word0;
      word0 = SBOX[word1]! ^ RCON[rconIndex]!;
      word1 = SBOX[word2]!;
      word2 = SBOX[word3]!;
      word3 = SBOX[temp]!;
      rconIndex += 1;
    }
    expanded[offset] = expanded[offset - 16]! ^ word0;
    expanded[offset + 1] = expanded[offset - 15]! ^ word1;
    expanded[offset + 2] = expanded[offset - 14]! ^ word2;
    expanded[offset + 3] = expanded[offset - 13]! ^ word3;
  }
  return expanded;
}

function addRoundKey(state: Uint8Array, keys: RoundKeys, round: number): void {
  for (let index = 0; index < 16; index += 1) {
    state[index] = state[index]! ^ keys[round * 16 + index]!;
  }
}

/** 状态按列存放：`state[row + 4 * column]`。 */
function shiftRows(state: Uint8Array): void {
  let temp = state[1]!;
  state[1] = state[5]!;
  state[5] = state[9]!;
  state[9] = state[13]!;
  state[13] = temp;

  temp = state[2]!;
  state[2] = state[10]!;
  state[10] = temp;
  temp = state[6]!;
  state[6] = state[14]!;
  state[14] = temp;

  temp = state[15]!;
  state[15] = state[11]!;
  state[11] = state[7]!;
  state[7] = state[3]!;
  state[3] = temp;
}

function invShiftRows(state: Uint8Array): void {
  let temp = state[13]!;
  state[13] = state[9]!;
  state[9] = state[5]!;
  state[5] = state[1]!;
  state[1] = temp;

  temp = state[2]!;
  state[2] = state[10]!;
  state[10] = temp;
  temp = state[6]!;
  state[6] = state[14]!;
  state[14] = temp;

  temp = state[3]!;
  state[3] = state[7]!;
  state[7] = state[11]!;
  state[11] = state[15]!;
  state[15] = temp;
}

function mixColumns(state: Uint8Array): void {
  for (let column = 0; column < 4; column += 1) {
    const base = column * 4;
    const a0 = state[base]!;
    const a1 = state[base + 1]!;
    const a2 = state[base + 2]!;
    const a3 = state[base + 3]!;
    state[base] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
    state[base + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
    state[base + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
    state[base + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
  }
}

function invMixColumns(state: Uint8Array): void {
  for (let column = 0; column < 4; column += 1) {
    const base = column * 4;
    const a0 = state[base]!;
    const a1 = state[base + 1]!;
    const a2 = state[base + 2]!;
    const a3 = state[base + 3]!;
    state[base] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
    state[base + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
    state[base + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
    state[base + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
  }
}

function encryptBlock(keys: RoundKeys, block: Uint8Array): Uint8Array {
  const state = Uint8Array.from(block);
  addRoundKey(state, keys, 0);
  for (let round = 1; round <= 10; round += 1) {
    for (let index = 0; index < 16; index += 1) state[index] = SBOX[state[index]!]!;
    shiftRows(state);
    if (round !== 10) mixColumns(state);
    addRoundKey(state, keys, round);
  }
  return state;
}

function decryptBlock(keys: RoundKeys, block: Uint8Array): Uint8Array {
  const state = Uint8Array.from(block);
  addRoundKey(state, keys, 10);
  for (let round = 9; round >= 0; round -= 1) {
    invShiftRows(state);
    for (let index = 0; index < 16; index += 1) state[index] = INV_SBOX[state[index]!]!;
    addRoundKey(state, keys, round);
    if (round !== 0) invMixColumns(state);
  }
  return state;
}

/* ─────────────────────── 静态表：初始化一次 ─────────────────────── */

/**
 * 用生成元 3 的幂构造 GF(2^8)，再按定义算 S 盒；比抄表更不容易抄错。
 *
 * `exp[i] = 3^i`，`log[exp[i]] = i`，于是 `inverse[v] = exp[(255 - log[v]) % 255]`
 * （`v = 0` 规定逆元为 0）。指数表只用 255 项：乘法的周期是 255。
 */
(function initTables() {
  const exp = new Uint8Array(255);
  const log = new Uint8Array(256);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exp[index] = value;
    log[value] = index;
    value = mul(value, 3);
  }
  // 生成元必须是本原元；否则表会提前循环，S 盒就悄悄错了。
  if (value !== 1) throw new Error("GF(2^8) 生成元不是本原元");

  const rotated = (x: number, shift: number) => ((x << shift) | (x >> (8 - shift))) & 0xff;
  for (let byte = 0; byte < 256; byte += 1) {
    const inverse = byte === 0 ? 0 : exp[(255 - log[byte]!) % 255]!;
    // 仿射变换：b ^ rotl(b,1) ^ rotl(b,2) ^ rotl(b,3) ^ rotl(b,4) ^ 0x63
    const s = inverse ^ rotated(inverse, 1) ^ rotated(inverse, 2) ^ rotated(inverse, 3)
      ^ rotated(inverse, 4) ^ 0x63;
    SBOX[byte] = s;
    INV_SBOX[s] = byte;
  }
})();
