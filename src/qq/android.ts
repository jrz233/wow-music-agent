/**
 * QQ 音乐 Android 登录上下文。
 *
 * `CreateQRCode` / `Login` 不是裸的 `musicu.fcg` 调用：Android 客户端会带上一整套
 * 设备指纹，并且先用匿名 `GetSession` 取 `uid`/`sid`。缺了这些，二维码能出、也能
 * 扫，但换票时上游只会回一个没有上下文的业务错误（实测 50006）。
 *
 * 这里按 wow-origin / QQMusicApi 的 Android 实现补齐三件事：
 *
 *   1. 每个二维码一套稳定的设备身份（aid / OpenUDID / OpenUDID2 / imei）；
 *   2. 由设备身份申请 QIMEI36（AES + RSA + MD5 的公开协议，结果缓存一天）；
 *   3. 用同一设备身份申请匿名 Android 会话（uid/sid，按自然日复用）。
 *
 * 凭据里会带着设备身份，续期时复用同一套；QIMEI 与会话只在内存里缓存，
 * Durable Object 冷启动后重新申请即可。
 */

import {
  constants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { unavailable } from "../shared/errors";
import { cookieValue, platformFetch, setCookies } from "../shared/http";

const MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const QIMEI_URL = "https://api.tencentmusic.com/tme/trpc/proxy";
const UA = "QQMusic 14090008(android 15)";

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEIxgwoutfwoJxcGQeedgP7FG9qaIuS0qzfR8gWkrkTZKM2iWHn2ajQpBRZjMSoSf6+KJGvar2ORhBfpDXyVtZCKpqLQ+FLkpncClKVIrBwv6PHyUvuCb0rIarmgDnzkfQAqVufEtR64iazGDKatvJ9y6B9NMbHddGSAUmRTCrHQIDAQAB
-----END PUBLIC KEY-----`;
const QIMEI_SECRET = "ZdJqM15EeO2zWc08";
const QIMEI_APP_KEY = "0AND0HD6FE4HY80F";
const QIMEI_EXTRA = JSON.stringify({ appKey: QIMEI_APP_KEY });
const QIMEI_SIGN_KEY = "qimei_qq_androidpzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH";
const DAY_MS = 24 * 60 * 60 * 1000;

/** 设备指纹。登录、换票、续期必须复用同一套。 */
export interface QQDevice {
  androidId: string;
  openUdid: string;
  openUdid2: string;
  imei: string;
  model: string;
  release: string;
  sdk: number;
}

export interface AndroidSession {
  uid: string;
  sid: string;
  savedAt: number;
}

interface Qimei {
  q16: string;
  q36: string;
  savedAt: number;
}

/** 换票参数里的 `musicid` 要原样写成 JSON 数字（微信账号有 19 位）。 */
export class RawNumber {
  constructor(readonly digits: string) {}
}

/** 把 `RawNumber` 原样写进 JSON，其余交给 `JSON.stringify`。 */
export function stringifyJson(value: unknown): string {
  const raw: string[] = [];
  const body = JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof RawNumber) {
      raw.push(item.digits);
      return `__raw_number_${raw.length - 1}__`;
    }
    return item;
  });
  return body.replace(/"__raw_number_(\d+)__"/gu, (_match, index: string) => {
    return raw[Number(index)] ?? "0";
  });
}

/** 一个二维码一套设备身份；之后由凭据 Cookie 原样带回。 */
export function newDevice(): QQDevice {
  return {
    androidId: randomBytes(8).toString("hex"),
    openUdid: randomUUID().replace(/-/gu, ""),
    openUdid2: randomUUID().replace(/-/gu, ""),
    imei: randomImei(),
    model: "V2408A",
    release: "15",
    sdk: 35,
  };
}

export function deviceCookie(device: QQDevice): string {
  return [
    `android_id=${device.androidId}`,
    `open_udid=${device.openUdid}`,
    `open_udid2=${device.openUdid2}`,
    `imei=${device.imei}`,
  ].join("; ");
}

/** 续期必须复用登录时的设备身份；缺失时现生成一个（仅影响风控，不影响正确性）。 */
export function deviceFrom(cookie: string): QQDevice {
  const androidId = cookieValue(cookie, "android_id");
  const openUdid = cookieValue(cookie, "open_udid");
  if (!/^[0-9a-f]{16}$/u.test(androidId) || !/^[0-9a-f]{32}$/u.test(openUdid)) {
    return newDevice();
  }
  const openUdid2 = cookieValue(cookie, "open_udid2");
  const imei = cookieValue(cookie, "imei");
  return {
    androidId,
    openUdid,
    openUdid2: /^[0-9a-f]{32}$/u.test(openUdid2) ? openUdid2 : randomUUID().replace(/-/gu, ""),
    imei: /^\d{15}$/u.test(imei) ? imei : randomImei(),
    model: "V2408A",
    release: "15",
    sdk: 35,
  };
}

export interface QQCgiResult {
  code: number;
  data: Record<string, unknown>;
  cookies: string[];
  topCode: number;
  topMsg: string;
}

export class AndroidContext {
  private qimei: Qimei | null = null;
  private qimeiPending: Promise<Qimei | null> | null = null;
  private session: AndroidSession | null = null;
  private sessionPending: Promise<AndroidSession | null> | null = null;

  constructor(readonly device: QQDevice) {}

  /**
   * 调一个登录族 CGI。
   *
   * `credential` 决定 comm 里的 `qq`/`authst`/`tmeLoginType`（匿名登录传空），
   * `extra` 是接口自己的差异字段（例如 CreateQRCode 的 `ct/cv`）。
   */
  async call(
    module: string,
    method: string,
    param: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    credential: Record<string, unknown> = {},
  ): Promise<QQCgiResult> {
    const qimei = await this.ensureQimei();
    const session = await this.ensureSession(qimei);
    return this.post(module, method, param, extra, credential, qimei, session);
  }

  private async post(
    module: string,
    method: string,
    param: Record<string, unknown>,
    extra: Record<string, unknown>,
    credential: Record<string, unknown>,
    qimei: Qimei | null,
    session: AndroidSession | null,
  ): Promise<QQCgiResult> {
    const body = stringifyJson({
      comm: this.comm(credential, extra, qimei, session),
      req_0: { module, method, param },
    });
    const response = await platformFetch(MUSICU, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body,
      timeoutMs: 20_000,
    });
    const payload = await jsonOf(response);
    const request = asRecord(payload.req_0) ?? {};
    return {
      code: Number(request.code ?? -1),
      data: asRecord(request.data) ?? {},
      cookies: setCookies(response),
      topCode: Number(payload.code ?? 0),
      topMsg: text(payload.msg),
    };
  }

  private comm(
    credential: Record<string, unknown>,
    additions: Record<string, unknown>,
    qimei: Qimei | null,
    session: AndroidSession | null,
  ): Record<string, string> {
    const device = this.device;
    const musicid = String(credential.musicid ?? credential.uin ?? "").replace(/^o/u, "");
    const musickey = String(credential.musickey ?? credential.qm_keyst ?? "");
    const loginType = Number(credential.loginType ?? 0);
    const values: Record<string, unknown> = {
      ct: 11,
      cv: 14090008,
      v: 14090008,
      chid: "10003505",
      ...(musicid ? { qq: musicid } : {}),
      ...(musickey ? { authst: musickey } : {}),
      tmeAppID: "qqmusic",
      ...(loginType ? { tmeLoginType: loginType } : {}),
      QIMEI36: qimei?.q36 ?? "",
      OpenUDID: device.openUdid,
      udid: device.openUdid,
      ...(session ? { uid: session.uid } : {}),
      OpenUDID2: device.openUdid2,
      ...(session ? { sid: session.sid } : {}),
      aid: device.androidId,
      os_ver: device.release,
      phonetype: device.model,
      ...additions,
    };
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
  }

  /** QIMEI 申请失败不阻断登录：没有它也能发出请求，只是风控信息不全。 */
  private ensureQimei(): Promise<Qimei | null> {
    if (this.qimei && Date.now() - this.qimei.savedAt < DAY_MS) {
      return Promise.resolve(this.qimei);
    }
    if (!this.qimeiPending) {
      this.qimeiPending = requestQimei(this.device)
        .then((value) => {
          this.qimei = { ...value, savedAt: Date.now() };
          return this.qimei;
        })
        .catch((error: unknown) => {
          console.warn("qq qimei unavailable", { message: (error as Error).message });
          return null;
        })
        .finally(() => {
          this.qimeiPending = null;
        });
    }
    return this.qimeiPending;
  }

  /** 匿名 Android 会话；申请失败同样不阻断，comm 里不带 uid/sid 而已。 */
  private ensureSession(qimei: Qimei | null): Promise<AndroidSession | null> {
    if (this.session && sameLocalDay(this.session.savedAt)) {
      return Promise.resolve(this.session);
    }
    if (!this.sessionPending) {
      this.sessionPending = this.requestSession(qimei)
        .then((value) => {
          this.session = value;
          return this.session;
        })
        .catch((error: unknown) => {
          console.warn("qq android session unavailable", { message: (error as Error).message });
          return null;
        })
        .finally(() => {
          this.sessionPending = null;
        });
    }
    return this.sessionPending;
  }

  private async requestSession(qimei: Qimei | null): Promise<AndroidSession> {
    const stale = this.session;
    const result = await this.post(
      "music.getSession.session",
      "GetSession",
      { uid: stale?.uid ?? "", vkey: 0, caller: stale ? 1 : 2 },
      {},
      {},
      qimei,
      null,
    );
    if (result.code !== 0) {
      throw unavailable(`QQ 音乐会话获取失败 (${result.code})`);
    }
    const session = asRecord(result.data.session);
    const uid = text(session?.uid);
    const sid = text(session?.sid);
    if (!uid || !sid) {
      throw unavailable("QQ 音乐未返回 Android 会话");
    }
    return { uid, sid, savedAt: Date.now() };
  }
}

/**
 * 同设备的上下文跨请求复用：`QQClient` 每个状态轮询都会新建，QIMEI 与匿名会话
 * 不能跟着一起重刷。上限 8 条，防止长时间运行后无限增长。
 */
const contexts = new Map<string, AndroidContext>();

export function contextFor(device: QQDevice): AndroidContext {
  const key = `${device.androidId}:${device.openUdid}`;
  const existing = contexts.get(key);
  if (existing) {
    return existing;
  }
  const context = new AndroidContext(device);
  contexts.set(key, context);
  if (contexts.size > 8) {
    const oldest = contexts.keys().next().value;
    if (oldest !== undefined && oldest !== key) {
      contexts.delete(oldest);
    }
  }
  return context;
}

// ---- QIMEI ----

function randomHex(length: number): string {
  return Array.from(randomBytes(length), (byte) => (byte & 15).toString(16)).join("");
}

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

function md5(...values: (string | number)[]): string {
  const hash = createHash("md5");
  values.forEach((value) => hash.update(String(value)));
  return hash.digest("hex");
}

function aesBase64(key: string, value: string, iv = key): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]).toString("base64");
}

function randomImei(): string {
  const digits = Array.from({ length: 14 }, () => randomInt(10));
  const sum = digits.reduce((total, digit, index) => {
    const doubled = index % 2 ? digit * 2 : digit;
    return total + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return `${digits.join("")}${(10 - (sum % 10)) % 10}`;
}

function beaconId(): string {
  const month = `${new Date().toISOString().slice(0, 8)}01`;
  const suffix = `${100000 + randomInt(900000)}.${100000000 + randomInt(900000000)}`;
  const dated = new Set([1, 2, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38]);
  let value = "";
  for (let index = 1; index <= 40; index += 1) {
    const part = dated.has(index)
      ? `${month}${suffix}`
      : index === 3
        ? "0000000000000000"
        : index === 4
          ? randomHex(16).replace(/0/gu, "a")
          : String(randomInt(10000));
    value += `k${index}:${part};`;
  }
  return value;
}

function qimeiPayload(device: QQDevice): Record<string, unknown> {
  const now = new Date(Date.now() - randomInt(14401) * 1000);
  const uptime = now.toISOString().slice(0, 19).replace("T", " ");
  const ipHash = Buffer.from(md5(device.androidId), "hex");
  const reserved = {
    harmony: "0",
    clone: "0",
    containe: "",
    oz: aesBase64("lvcwmSYVr2Axv1gn", device.androidId, "Zs0ntDqG2jyhKN0c"),
    oo: aesBase64("lvcwmSYVr2Axv1gn", device.model, "Zs0ntDqG2jyhKN0c"),
    kelong: "0",
    ip: `192.168.${ipHash[0]}.${(ipHash[1] ?? 0) % 253 + 2}`,
    uptimes: uptime,
    multiUser: "0",
    bod: "sun",
    brd: "vivo",
    dv: "PD2408",
    firstLevel: String(device.sdk),
    manufact: "vivo",
    name: "PD2408",
    host: "comdg01150014",
    kernel:
      "Linux localhost 6.6.89-android15-8-g1f71897ac249-abogki467805059-4k #1 SMP PREEMPT Thu Dec 11 01:56:00 UTC 2025 aarch64",
    pre: "0",
    av: "14.9.0.8",
    ch: "",
  };
  return {
    androidId: device.androidId,
    platformId: 1,
    appKey: QIMEI_APP_KEY,
    appVersion: "14.9.0.8",
    beaconIdSrc: beaconId(),
    brand: "vivo",
    channelId: "10003505",
    cid: "",
    imei: device.imei,
    imsi: "",
    mac: "",
    model: device.model,
    networkType: "wifi",
    oaid: "",
    osVersion: `Android ${device.release},level ${device.sdk}`,
    qimei: "",
    qimei36: "",
    sdkVersion: "1.2.13.6",
    targetSdkVersion: "30",
    audit: "",
    userId: "{}",
    packageId: "com.tencent.qqmusic",
    deviceType: "Phone",
    sdkName: "",
    reserved: JSON.stringify(reserved),
  };
}

async function requestQimei(device: QQDevice): Promise<{ q16: string; q36: string }> {
  const cryptKey = randomHex(16);
  const nonce = randomHex(16);
  const seconds = Math.floor(Date.now() / 1000);
  const key = publicEncrypt(
    { key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(cryptKey),
  ).toString("base64");
  const params = aesBase64(cryptKey, JSON.stringify(qimeiPayload(device)));
  const response = await platformFetch(QIMEI_URL, {
    method: "POST",
    timeoutMs: 20_000,
    headers: {
      "Content-Type": "application/json",
      method: "GetQimei",
      service: "trpc.tme_datasvr.qimeiproxy.QimeiProxy",
      appid: "qimei_qq_android",
      sign: md5(QIMEI_SIGN_KEY, seconds),
      "User-Agent": "QQMusic",
      timestamp: String(seconds),
    },
    body: JSON.stringify({
      app: 0,
      os: 1,
      qimeiParams: {
        key,
        params,
        time: String(seconds),
        nonce,
        sign: md5(key, params, seconds * 1000, nonce, QIMEI_SECRET, QIMEI_EXTRA),
        extra: QIMEI_EXTRA,
      },
    }),
  });
  if (!response.ok) {
    throw unavailable(`QQ 设备标识请求失败 (HTTP ${response.status})`);
  }
  const outer = (await response.json()) as { data?: unknown };
  const result = (typeof outer?.data === "string" ? JSON.parse(outer.data) : outer?.data) as {
    data?: { q16?: unknown; q36?: unknown };
  } | null;
  const qimei = result?.data;
  if (!qimei?.q16 || !qimei?.q36) {
    throw unavailable("QQ 设备标识响应缺少 QIMEI");
  }
  return { q16: String(qimei.q16), q36: String(qimei.q36) };
}

function sameLocalDay(timestamp: number): boolean {
  return new Date(timestamp).toDateString() === new Date().toDateString();
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw unavailable("QQ 音乐返回的不是 JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) return String(value);
  return "";
}
