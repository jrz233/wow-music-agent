/**
 * QQ 音乐扫码登录与 musicu.fcg 传输层。
 *
 * QQ 的登录链路比网易云长：ptlogin 二维码 → `ptuiCB` 成功 URL → graph.qq.com
 * 的 302 链 → y.qq.com 的 Cookie。这里手动跟随重定向，逐个响应合并 Set-Cookie，
 * 最终只保留 `qqmusic_*` / `uin` / `skey` 等 QQ 音乐自己认的键。
 *
 * QQ 的私有接口会随客户端版本变化，因此所有读取都走一个宽松的 `musicu()`：
 * 只要求 `code === 0`，字段映射在 `api.ts` 里做多路兼容。
 */

import { mergeCookies, parseCookies, platformFetch, cookieValue, setCookies } from "../shared/http";
import { unavailable } from "../shared/errors";
import { imageDataUrl, sniffImageMime } from "../shared/image";

const LOGIN_JUMP = "https://graph.qq.com/oauth2.0/login_jump";
const MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const REFERER = "https://y.qq.com/";
const APPID = "716027609";
const DAID = "383";
const PT_3RD_AID = "100497308";

/**
 * ptlogin 的两个入口。
 *
 * 主机与路径必须配对：`ssl.ptlogin2.qq.com` 配 `/ptqrshow`，`xui.ptlogin2.qq.com`
 * 配 `/ssl/ptqrshow`，交叉搭配会 302 到别处去（拿不到图）。
 *
 * 两个入口返回的都是 PNG，但**都不带 content-type 头**，只能靠魔数识别。
 * `xui` 这一路先访问一次 `/cgi-bin/xlogin`，它会下发 `pt_login_sig`、`uikey` 等
 * Cookie；轮询 `ptqrlogin` 时要带上 `pt_login_sig`，缺失会影响扫码成功后的换票。
 */
interface QQEndpoint {
  base: string;
  show: string;
  poll: string;
  referer: string;
  needsXLogin: boolean;
}

const QQ_ENDPOINTS: QQEndpoint[] = [
  {
    base: "https://xui.ptlogin2.qq.com",
    show: "/ssl/ptqrshow",
    poll: "/ssl/ptqrlogin",
    referer: "https://xui.ptlogin2.qq.com/cgi-bin/xlogin",
    needsXLogin: true,
  },
  {
    base: "https://ssl.ptlogin2.qq.com",
    show: "/ptqrshow",
    poll: "/ptqrlogin",
    referer: "https://y.qq.com/",
    needsXLogin: false,
  },
];

const MUSIC_HEADERS = {
  "Content-Type": "application/json",
  Referer: REFERER,
  Origin: "https://y.qq.com",
};

export interface QQAccount {
  userId: string;
  nickname: string;
  avatarUrl: string;
}

export interface QQLoginResult {
  credential: string;
  account: QQAccount;
}

export interface QQConflict {
  state: "waiting" | "scanned" | "expired";
}

export type QQLoginState = QQConflict | { state: "success"; result: QQLoginResult };

export class QQClient {
  cookie: string;
  /** 真正吐出二维码的那个入口；轮询必须回到同一台机器，否则 qrsig 对不上。 */
  private endpoint: QQEndpoint;

  constructor(cookie = "") {
    this.cookie = cookie;
    this.endpoint = QQ_ENDPOINTS[0] as QQEndpoint;
  }

  get uin(): string {
    const numeric = cookieValue(this.cookie, "qqmusic_uin");
    if (numeric) return numeric;
    const raw = cookieValue(this.cookie, "uin");
    return raw.replace(/^o/u, "");
  }

  /**
   * 二维码图片 + qrsig Cookie。
   *
   * ptqrshow 回的 PNG **不带 content-type 头**，所以这里只认魔数；
   * 拿不到图就换另一个入口（主机与路径要配对，见 QQ_ENDPOINTS）。
   */
  async createQR(): Promise<{ imageDataUrl: string; cookie: string }> {
    const query = new URLSearchParams({
      appid: APPID,
      e: "2",
      l: "M",
      s: "3",
      d: "72",
      v: "4",
      t: `${Math.random()}`,
      daid: DAID,
      pt_3rd_aid: PT_3RD_AID,
      u1: LOGIN_JUMP,
    });
    let failure: Error | null = null;
    for (const endpoint of QQ_ENDPOINTS) {
      try {
        if (endpoint.needsXLogin) {
          await this.xlogin(endpoint);
        }
        const response = await platformFetch(`${endpoint.base}${endpoint.show}?${query.toString()}`, {
          headers: { Referer: endpoint.referer, Accept: "image/*" },
          redirect: "manual",
        });
        this.cookie = mergeCookies(this.cookie, response);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const mime = sniffImageMime(bytes);
        if (!response.ok || !mime) {
          failure = unavailable("QQ 二维码获取失败");
          continue;
        }
        if (!cookieValue(this.cookie, "qrsig")) {
          failure = unavailable("QQ 二维码响应缺少 qrsig");
          continue;
        }
        this.endpoint = endpoint;
        return { imageDataUrl: imageDataUrl(bytes, mime), cookie: this.cookie };
      } catch (error) {
        failure = error as Error;
      }
    }
    throw failure ?? unavailable("QQ 二维码获取失败");
  }

  /** 访问一次登录页，拿到 `pt_login_sig` / `uikey` 等 Cookie。 */
  private async xlogin(endpoint: QQEndpoint): Promise<void> {
    const url = new URL("/cgi-bin/xlogin", endpoint.base);
    url.search = new URLSearchParams({
      appid: APPID,
      daid: DAID,
      style: "33",
      hide_title_bar: "1",
      hide_border: "1",
      target: "self",
      s_url: LOGIN_JUMP,
      pt_3rd_aid: PT_3RD_AID,
    }).toString();
    const response = await platformFetch(url.toString(), {
      headers: { Referer: `${endpoint.base}/`, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      redirect: "manual",
    });
    this.cookie = mergeCookies(this.cookie, response);
    await response.arrayBuffer().catch(() => undefined);
  }

  /** 轮询扫码状态。成功时返回登录后的 Cookie 与账号信息。 */
  async checkQR(): Promise<QQLoginState> {
    const qrsig = cookieValue(this.cookie, "qrsig");
    if (!qrsig) {
      throw unavailable("QQ 二维码会话已失效");
    }
    const query = new URLSearchParams({
      u1: LOGIN_JUMP,
      ptqrtoken: String(hash33(qrsig)),
      ptredirect: "0",
      h: "1",
      t: "1",
      g: "1",
      from_ui: "1",
      ptlang: "2052",
      action: `0-0-${Date.now()}`,
      js_ver: "25100115",
      js_type: "1",
      login_sig: cookieValue(this.cookie, "pt_login_sig"),
      pt_uistyle: "40",
      aid: APPID,
      daid: DAID,
      pt_3rd_aid: PT_3RD_AID,
    });
    const response = await platformFetch(`${this.endpoint.base}${this.endpoint.poll}?${query.toString()}`, {
      headers: { Referer: this.endpoint.referer, Cookie: this.cookie, Accept: "*/*" },
      redirect: "manual",
    });
    this.cookie = mergeCookies(this.cookie, response);
    const body = await response.text();
    const parsed = parsePtuiCB(body);
    if (!parsed) {
      return { state: "waiting" };
    }
    if (parsed.code === "65") {
      return { state: "expired" };
    }
    if (parsed.code === "67") {
      return { state: "scanned" };
    }
    if (parsed.code !== "0" || !parsed.url) {
      return { state: "waiting" };
    }
    const credential = await this.followLogin(parsed.url);
    const uin = this.uin || cookieValue(credential, "qqmusic_uin");
    const nickname = parsed.nickname || uin;
    return {
      state: "success",
      result: {
        credential,
        account: {
          userId: uin,
          nickname,
          avatarUrl: uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=140` : "",
        },
      },
    };
  }

  /**
   * 跟随 ptuiCB 返回的 URL，收集整条 302 链上的 Cookie。
   * 遇到 `y.qq.com` 且已经拿到 `qqmusic_key` 就停止，避免继续跳到无关页面。
   */
  private async followLogin(url: string): Promise<string> {
    let current = url;
    let cookies = this.cookie;
    for (let hop = 0; hop < 10; hop += 1) {
      const response = await platformFetch(current, {
        headers: { Referer: REFERER, Cookie: cookies },
        redirect: "manual",
      });
      cookies = mergeCookies(cookies, response);
      const location = response.headers.get("location");
      if (!location) {
        break;
      }
      current = new URL(location, current).toString();
      const host = new URL(current).hostname;
      if (host === "y.qq.com" && cookieValue(cookies, "qqmusic_key")) {
        break;
      }
    }
    this.cookie = cookies;
    return cookies;
  }

  /** 调一个 musicu 模块；返回 `req_0.data`。 */
  async call(module: string, method: string, param: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      comm: {
        ct: "11",
        cv: "1003006",
        v: "1003006",
        uin: this.uin || "0",
        format: "json",
        tmeAppID: "qqmusic",
      },
      req_0: { module, method, param },
    });
    const response = await platformFetch(MUSICU, {
      method: "POST",
      headers: { ...MUSIC_HEADERS, Cookie: this.cookie },
      body,
    });
    this.cookie = mergeCookies(this.cookie, response);
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw unavailable("QQ 音乐返回的不是 JSON");
    }
    const request = payload.req_0 as Record<string, unknown> | undefined;
    if (!request || Number(request.code ?? -1) !== 0) {
      throw unavailable("QQ 音乐接口返回错误");
    }
    return (request.data as Record<string, unknown> | undefined) ?? {};
  }

  /** 用「拉一张歌单」探活；成功即视为 Cookie 仍有效。 */
  async alive(): Promise<boolean> {
    try {
      await this.call("music.musichallSongListServer", "GetUserMusicList", {
        uin: this.uin,
        offset: 0,
        limit: 1,
        order: 0,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** QQ 的 ptqrtoken 算法：hash33。 */
export function hash33(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash << 5) + hash + character.charCodeAt(0);
    hash &= 0x7fffffff;
  }
  return hash;
}

export function parsePtuiCB(
  body: string,
): { code: string; subcode: string; url: string; message: string; nickname: string } | null {
  // ptuiCB('0','0','https://…','0','登录成功', '昵称');
  const match = body.match(/ptuiCB\(([^)]*)\)/u);
  if (!match) return null;
  const args = [...(match[1] ?? "").matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? "");
  if (args.length < 5) return null;
  return {
    code: args[0] ?? "",
    subcode: args[1] ?? "",
    url: (args[2] ?? "").replace(/&amp;/gu, "&"),
    message: decodeNickname(args[4] ?? ""),
    nickname: decodeNickname(args[5] ?? ""),
  };
}

function decodeNickname(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function cookiesFrom(response: Response): string[] {
  return setCookies(response);
}

export function cookieJar(raw: string): Map<string, string> {
  return parseCookies(raw);
}
