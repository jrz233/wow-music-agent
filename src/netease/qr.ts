/**
 * 二维码渲染：本地画成 SVG，再内联成 data URL。
 *
 * 与 wow-origin 的做法一致：二维码的内容就是网易云的 codekey 登录页
 * （`https://music.163.com/login?codekey=…`），由 Worker 自己编码，不去网易云取图。
 *
 * 为什么不复用网易云的 `/api/web/qrcode/get`：
 *  - 那是网页版登录页的私有接口，随时可能改；
 *  - 图片在 CDN 上，用户扫一次码就等于把 IP 暴露给图片域；
 *  - 管理页的 CSP 只放行 `img-src 'self' data:`，本地渲染天然合规。
 *
 * SVG 而不是 PNG：矢量在任何屏幕上都不糊，且不用再引一个位图编码器。
 */

import QRCode from "qrcode";

/** 网易云扫码登录页；`codekey` 由 `login/qrcode/unikey` 返回。 */
export function neteaseLoginURL(unikey: string): string {
  return `https://music.163.com/login?codekey=${encodeURIComponent(unikey)}`;
}

/**
 * 把任意文本渲染成二维码 data URL（`image/svg+xml`）。
 *
 * 纠错等级用 H：手机相机在斜着扫的时候更容易读出来。
 */
export function qrCodeDataUrl(text: string, margin = 1): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "H" });
  const size = qr.modules.size;
  const viewBox = size + margin * 2;
  const paths: string[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (qr.modules.get(row, column)) {
        paths.push(`M${column + margin} ${row + margin}h1v1h-1z`);
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" ` +
    `shape-rendering="crispEdges">` +
    `<path fill="#fff" d="M0 0h${viewBox}v${viewBox}H0z"/>` +
    `<path fill="#000" d="${paths.join("")}"/></svg>`;
  return `data:image/svg+xml;base64,${base64(new TextEncoder().encode(svg))}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
