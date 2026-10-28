/**
 * 图片类型嗅探与 data URL 拼装。
 *
 * 为什么不能只看 `Content-Type`：QQ 的 `ptqrshow` 回的确实是 PNG，但响应里**没有**
 * `content-type` 头——只看头就会把好图当坏图丢掉，二维码永远显示不出来。
 * 所以这里按魔数判断格式，`Content-Type` 只作为「有就优先参考」的旁证。
 */

/** 各平台的二维码接口返回的都是常见位图，这里覆盖够用即可。 */
const SIGNATURES: { mime: string; bytes: number[] }[] = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

/** 按魔数判断图片格式；不是图片返回 null。 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  for (const signature of SIGNATURES) {
    if (matches(bytes, signature.bytes, 0)) {
      return signature.mime;
    }
  }
  // WEBP: "RIFF" .... 4 字节 .... "WEBP"
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46], 0) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/** 把图片字节内联成 data URL；管理页的 CSP 只放行 `img-src 'self' data:`。 */
export function imageDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function matches(bytes: Uint8Array, signature: number[], offset: number): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}
