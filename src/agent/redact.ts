/**
 * 日志脱敏。
 *
 * Agent 不记录请求/响应本体；只在出现异常时记录一句可诊断的信息。即便调用方
 * 误把平台报文带进来，这里也会把 Cookie、Bearer、签名等敏感值清掉。
 */

const PATTERNS: [RegExp, string][] = [
  [/((?:cookie|set-cookie)\s*["']?\s*[:=]\s*["']?)[^\n]+/giu, "$1[redacted]"],
  [/((?:authorization|proxy-authorization)\s*["']?\s*[:=]\s*["']?)[^\n]+/giu, "$1[redacted]"],
  [/((?:token|access_token|refresh_token|pairingtoken|pairing_token|password|secret|credential)\s*["']?\s*[=:]\s*["']?)[^"'&\s,;}]+/giu, "$1[redacted]"],
  [/((x-wow-(?:signature|response-signature|nonce))\s*["']?\s*[:=]\s*["']?)[^\n]+/giu, "$1[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[redacted-jwt]"],
];

export function redact(value: unknown): string {
  let text: string;
  if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  let result = text;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  // 控制字符会让日志/面板排版错乱。
  return result.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500);
}

/** 只保留错误类型与非敏感摘要，用于写入 `last_error`。 */
export function safeError(value: unknown): string {
  return redact(value);
}
