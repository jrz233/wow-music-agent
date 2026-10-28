/**
 * 平台请求的小工具：超时、Cookie 解析、带浏览器形态的请求头。
 *
 * 平台（QQ 音乐 / 网易云）会对「不像浏览器的请求」做风控，所以 UA/Referer 固定成
 * 各家网页版；这些值不影响安全边界，只影响能不能拿到数据。
 */

import { unavailable } from "./errors";
export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  redirect?: "follow" | "error" | "manual";
}

/**
 * 网络层失败（超时、DNS、TLS）。与「平台明确拒绝」区分开：
 * 刷新逻辑只应把后者当作登录失效，前者应标记 degraded 稍后重试。
 */
export class PlatformNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformNetworkError";
  }
}

export async function platformFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const timeout = options.timeoutMs ?? 10_000;
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "User-Agent": DESKTOP_UA,
        ...options.headers,
      },
      body: options.body,
      redirect: options.redirect ?? "follow",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new PlatformNetworkError(`平台请求失败：${(error as Error).message}`);
  }
  return response;
}

export async function fetchJSON<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await platformFetch(url, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  const text = await response.text();
  if (!response.ok) {
    throw unavailable(`平台返回 HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw unavailable("平台返回的不是 JSON");
  }
}

/**
 * 解析 `Set-Cookie`。Workers 支持 `getSetCookie()`；测试环境的 undici 也支持。
 *
 * 光有 `getSetCookie()` 还不够：QQ 登录链会把**多个 Cookie 塞进同一个头**里（例如
 * `pt_oauth_token=…; Expires=…, p_skey=…; Path=/`），此时 `getSetCookie()` 原样返回
 * 这一整条，按 `;` 取第一个就只拿到前一个 Cookie，后面的 `p_skey` 直接丢掉——表现
 * 就是「扫码成功了，但会话校验拿不到 p_skey」。
 *
 * 逗号既可能是 `Expires=Wed, 21 Oct …` 里的日期分隔，也可能是两个 Cookie 的分隔，
 * 所以只在逗号后面紧跟 `name=` 时才切（与 wow-origin 的处理一致）。
 */
function splitSetCookie(header: string): string[] {
  return header
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/u)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  return values.flatMap(splitSetCookie);
}

/**
 * 把 `Set-Cookie` 行合并进 Cookie jar；同名 Cookie 以**最后一个非空值**为准。
 *
 * 登录链上服务端会用 `name=; Max-Age=0` 清掉旧 Cookie，也可能先清再下发新值。
 * 空值覆盖已有值会把刚拿到的 `p_skey` 抹掉，所以空值只在原本没有该 Cookie 时记录。
 */
export function applySetCookieLines(jar: Map<string, string>, headers: string[]): Map<string, string> {
  for (const header of headers) {
    const pair = header.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    if (value === "" && jar.has(key)) continue;
    jar.set(key, value);
  }
  return jar;
}

/** 把 `Set-Cookie` 的键值对合并进一个 `k=v; k=v` 字符串。 */
export function mergeCookies(current: string, response: Response): string {
  return serializeCookies(applySetCookieLines(parseCookies(current), setCookies(response)));
}

/**
 * 从 `Set-Cookie` 行里挑出浏览器会带给 `host` 的 Cookie。
 *
 * 只认带 `Domain` 且域名匹配的 Cookie：没有 `Domain` 的是下发主机（ptlogin）的
 * 主机独占 Cookie，浏览器不会把它带到 `check_sig` 所在的另一台机器上。
 */
export function cookiesForHost(headers: string[], host: string): Map<string, string> {
  const target = host.toLowerCase();
  const result = new Map<string, string>();
  for (const header of headers) {
    const parts = header.split(";").map((part) => part.trim());
    const pair = parts[0] ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key || value === "") continue;
    let domain = "";
    for (const attribute of parts.slice(1)) {
      const separator = attribute.indexOf("=");
      if (separator <= 0) continue;
      if (attribute.slice(0, separator).trim().toLowerCase() !== "domain") continue;
      domain = attribute
        .slice(separator + 1)
        .trim()
        .replace(/^\./u, "")
        .toLowerCase();
    }
    if (domain && (target === domain || target.endsWith(`.${domain}`))) {
      result.set(key, value);
    }
  }
  return result;
}

/** 在 Cookie 串里写入一项（已存在则覆盖）。 */
export function withCookie(jar: string, key: string, value: string): string {
  const map = parseCookies(jar);
  map.set(key, value);
  return serializeCookies(map);
}

export function parseCookies(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      result.set(key, value);
    }
  }
  return result;
}

export function serializeCookies(jar: Map<string, string>): string {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

/** 从值里挑一个 cookie；不存在返回空串。 */
export function cookieValue(raw: string, key: string): string {
  return parseCookies(raw).get(key) ?? "";
}

/** 安全的 JSON 字符串化（绝不抛出）。 */
export function safeJSON(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
