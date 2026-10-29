/**
 * wow-server → Agent 的只读能力接口。
 *
 * 安全约束：
 *   - 每条请求都必须带 wow-server 的 Ed25519 签名；验签包含 method、path、
 *     归一化 query、时间戳、nonce 与 body 哈希；
 *   - nonce 落 DO SQLite，时间窗内只能使用一次；
 *   - 平台令牌永远不会出现在响应里——这里返回的是 `shared/types.ts` 的语义化
 *     形状，wow-server 侧的 `Sanitize*` 还会再裁剪一次；
 *   - 响应也签名（绑定请求 nonce），wow-server 验签失败即视为离线。
 *
 * 路由与 `internal/features/agent/library.go` 的调用路径一一对应，新增路径必须
 * 同步更新白名单与文档。
 */

import { Hono, type Context } from "hono";
import type { AgentIdentity } from "./oauth";
import { agentSummary } from "./oauth";
import type { AgentStore } from "./store";
import type { AgentPlaylist, AgentPlaylistDetail, AgentTrack, Platform } from "../shared/types";
import {
  fetchDaily as fetchQQDaily,
  fetchFavorites as fetchQQFavorites,
  fetchPlaylistDetail as fetchQQPlaylistDetail,
  fetchPlaylists as fetchQQPlaylists,
  fetchRoam as fetchQQRoam,
} from "../qq/api";
import { QQClient } from "../qq/client";
import {
  fetchDaily as fetchNeteaseDaily,
  fetchFavorites as fetchNeteaseFavorites,
  fetchPlaylistDetail as fetchNeteasePlaylistDetail,
  fetchPlaylists as fetchNeteasePlaylists,
  fetchRoam as fetchNeteaseRoam,
} from "../netease/api";
import { NeteaseClient } from "../netease/client";
import {
  base64UrlDecode,
  canonicalRequest,
  canonicalResponse,
  HEADER_AGENT_ID,
  HEADER_NONCE,
  HEADER_RESPONSE_SIGNATURE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  importPublicKey,
  isValidNonce,
  isValidTimestamp,
  sign,
  verify,
} from "./signing";
import { AgentError, badRequest, conflict, unavailable, unauthorized } from "../shared/errors";
import { platformView } from "./refresh";
import { redact } from "./redact";
import { AGENT_API_VERSION, AGENT_VERSION } from "../env";
import { AGENT_COMMIT } from "../commit";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
/** 歌单曲目上限：与 wow-server `/v1` 的 trackLimit 上限一致，大歌单要能一次取全。 */
const MAX_TRACK_LIMIT = 1000;
const NONCE_RETENTION_SECONDS = 10 * 60;
const MAX_REQUEST_BODY = 64 * 1024;
/** 快照一次最多带多少张歌单的曲目：服务端按批补齐，避免一次调用打爆上游。 */
const SNAPSHOT_MAX_IDS = 20;
/** 快照内并发拉详情与收藏的数目；Cloudflare 子请求有上限，不要开太大。 */
const SNAPSHOT_CONCURRENCY = 4;
/** `/v1/status` 的能力清单：服务端据此判断能不能走批量快照。 */
const CAPABILITIES = ["library.snapshot"];

type Variables = { requestNonce: string };

export function createV1App(store: AgentStore, identity: AgentIdentity) {
  const app = new Hono<{ Variables: Variables }>();

  app.use("/v1/*", async (c, next) => {
    const body = await readBody(c.req.raw);
    const nonce = await authenticate(c.req.raw, body, store);
    c.set("requestNonce", nonce);
    await next();
  });

  app.get("/v1/status", (c) => {
    return signedJSON(c, identity, 200, {
      apiVersion: AGENT_API_VERSION,
      agentVersion: AGENT_VERSION,
      // 源码提交号：服务端拿它和上游仓库的最新提交号比，判断要不要提醒用户同步。
      agentCommit: AGENT_COMMIT,
      capabilities: CAPABILITIES,
      platforms: {
        qq: publicPlatform(platformView(store, "qq")),
        netease: publicPlatform(platformView(store, "netease")),
      },
    });
  });

  app.get("/v1/library/playlists", async (c) => {
    const platform = parsePlatform(c);
    const limit = parseLimit(c);
    const items = await withPlatform(store, platform, (credential) => {
      if (platform === "qq") {
        return fetchQQPlaylists(new QQClient(credential), limit);
      }
      return fetchNeteasePlaylists(new NeteaseClient(credential), limit);
    });
    return signedJSON(c, identity, 200, { items, hasMore: false, nextOffset: items.length });
  });

  app.get("/v1/library/playlists/:id/tracks", async (c) => {
    const platform = parsePlatform(c);
    // 曲目与列表分开限流：大歌单要能一次取到上千首。查询参数沿用 `limit` 以保持兼容。
    const limit = parseTrackLimit(c, "limit");
    const id = (c.req.param("id") ?? "").trim();
    if (id === "" || id.length > 128) {
      throw badRequest("歌单 id 无效");
    }
    const playlist = await withPlatform(store, platform, (credential) => {
      if (platform === "qq") {
        return fetchQQPlaylistDetail(new QQClient(credential), id, limit);
      }
      return fetchNeteasePlaylistDetail(new NeteaseClient(credential), id, limit);
    });
    return signedJSON(c, identity, 200, { playlist });
  });

  app.get("/v1/library/favorites/tracks", async (c) => {
    const platform = parsePlatform(c);
    const limit = parseLimit(c);
    const items = await withPlatform(store, platform, (credential) => {
      if (platform === "qq") {
        return fetchQQFavorites(new QQClient(credential), limit);
      }
      return fetchNeteaseFavorites(new NeteaseClient(credential), limit);
    });
    return signedJSON(c, identity, 200, { items, hasMore: false, nextOffset: items.length });
  });

  /**
   * 批量快照：一次往返拿回歌单列表、收藏，以及指定歌单的曲目。
   *
   * wow-server 侧会把结果落库预加载（`internal/features/agent/library_snapshot.go`）：
   * 面板与客户端读快照秒回，后台按分钟刷新。`ids` 为空时只取列表，用于常规刷新；
   * 带 `ids` 时才并发拉这几张歌单的曲目（上限 20 张）。
   *
   * 单个平台失败不影响另一个平台：失败信息放在该平台的 `error` 里，服务端只跳过
   * 那一块并在下一轮重试。
   */
  app.get("/v1/library/snapshot", async (c) => {
    const requested = (c.req.query("platform") ?? "all").trim();
    let platforms: Platform[];
    if (requested === "all") {
      platforms = ["qq", "netease"];
    } else if (requested === "qq" || requested === "netease") {
      platforms = [requested];
    } else {
      throw badRequest("platform 参数无效");
    }
    const limit = parseLimit(c);
    const trackLimit = parseTrackLimit(c);
    const ids = requested === "all" ? [] : parseSnapshotIDs(c.req.query("ids"));
    const result: Record<string, SnapshotPlatform> = {};
    await Promise.all(
      platforms.map(async (platform) => {
        result[platform] = await platformSnapshot(store, platform, limit, trackLimit, ids);
      }),
    );
    return signedJSON(c, identity, 200, { platforms: result });
  });

  app.get("/v1/recommend/daily", async (c) => {
    const platform = parsePlatform(c);
    const limit = parseLimit(c);
    const items = await withPlatform(store, platform, (credential) => {
      if (platform === "qq") {
        return fetchQQDaily(new QQClient(credential), limit);
      }
      return fetchNeteaseDaily(new NeteaseClient(credential), limit);
    });
    return signedJSON(c, identity, 200, { items, hasMore: false, nextOffset: items.length });
  });

  app.get("/v1/recommend/roam", async (c) => {
    const platform = parsePlatform(c);
    const limit = parseLimit(c);
    const mode = c.req.query("mode") === "radar" ? "radar" : "radio";
    // 口味只对 QQ 的「猜你喜欢」电台有意义；normalize 掉未知值，避免把任意字符串
    // 当业务参数透传给上游。
    const style = parseGuessStyle(c);
    const items = await withPlatform(store, platform, (credential) => {
      if (platform === "qq") {
        return fetchQQRoam(new QQClient(credential), mode, limit, style);
      }
      return fetchNeteaseRoam(new NeteaseClient(credential), limit);
    });
    return signedJSON(c, identity, 200, { items, hasMore: false, nextOffset: items.length });
  });

  app.get("/v1/summary", async (c) => {
    return signedJSON(c, identity, 200, {
      agent: await agentSummary(store, identity),
      platforms: {
        qq: publicPlatform(platformView(store, "qq")),
        netease: publicPlatform(platformView(store, "netease")),
      },
    });
  });

  app.notFound((c) => unsignedJSON(404, { error: "不存在" }));

  app.onError((error, c) => {
    const agentError = error instanceof AgentError ? error : unavailable("Agent 内部错误");
    if (!(error instanceof AgentError)) {
      console.error("agent v1 error", redact(error));
    }
    const nonce = c.get("requestNonce");
    if (!nonce) {
      return unsignedJSON(agentError.status, { error: agentError.publicMessage });
    }
    return signedJSON(c, identity, agentError.status, { error: agentError.publicMessage });
  });

  return app;
}

/**
 * 验签并登记 nonce；返回请求 nonce 供响应签名使用。
 * 任何失败都只回 401，不解释是哪一步错了。
 */
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY) {
    throw new AgentError(413, "请求体过大");
  }
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BODY) {
      throw new AgentError(413, "请求体过大");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function authenticate(request: Request, body: Uint8Array, store: AgentStore): Promise<string> {
  const record = store.agent();
  if (!record) {
    throw unauthorized();
  }
  if ((request.headers.get(HEADER_AGENT_ID) ?? "") !== record.agentId) {
    throw unauthorized();
  }
  const timestamp = request.headers.get(HEADER_TIMESTAMP) ?? "";
  const nonce = request.headers.get(HEADER_NONCE) ?? "";
  const signature = request.headers.get(HEADER_SIGNATURE) ?? "";
  if (!isValidNonce(nonce) || !isValidTimestamp(timestamp)) {
    throw unauthorized();
  }
  let publicKey: CryptoKey;
  try {
    publicKey = await importPublicKey(base64UrlDecode(record.serverPublicKey));
  } catch {
    throw unauthorized();
  }
  const url = new URL(request.url);
  const canonical = await canonicalRequest(
    request.method,
    url.pathname,
    url.search.replace(/^\?/u, ""),
    timestamp,
    nonce,
    body,
  );
  if (!(await verify(publicKey, canonical, signature))) {
    throw unauthorized();
  }
  const expiresAt = Number.parseInt(timestamp, 10) + NONCE_RETENTION_SECONDS;
  if (!store.useNonce(`agent:${record.agentId}`, nonce, expiresAt)) {
    throw unauthorized();
  }
  store.touchAgent(Math.floor(Date.now() / 1000));
  return nonce;
}

async function signedJSON(
  c: Context<{ Variables: Variables }>,
  identity: AgentIdentity,
  status: number,
  payload: unknown,
): Promise<Response> {
  const nonce = c.get("requestNonce");
  if (!nonce) {
    return unsignedJSON(401, { error: "未授权" });
  }
  const body = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body);
  const signature = await sign(identity.privateKey, await canonicalResponse(status, bytes, nonce));
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      [HEADER_RESPONSE_SIGNATURE]: signature,
    },
  });
}

function unsignedJSON(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function publicPlatform(view: ReturnType<typeof platformView>) {
  return {
    loggedIn: view.loggedIn,
    nickname: view.nickname,
    userId: view.accountId,
    avatarUrl: view.avatarUrl,
    lastRefreshAt: view.lastRefreshAt,
    expiresAt: view.expiresAt,
  };
}

function parsePlatform(c: Context): Platform {
  const value = c.req.query("platform") ?? "";
  if (value === "qq" || value === "netease") {
    return value;
  }
  throw badRequest("platform 参数无效");
}

function parseGuessStyle(c: Context): string {
  switch (c.req.query("style")) {
    case "familiar":
      return "familiar";
    case "fresh":
      return "fresh";
    default:
      return "balanced";
  }
}

function parseLimit(c: Context): number {
  const raw = c.req.query("limit") ?? "";
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(value, MAX_LIMIT);
}

/**
 * 歌单一侧取多少首。详情接口的参数名是 `limit`（与列表接口同名），快照接口
 * 用的是 `trackLimit`，由调用方指定 key。缺省 100，最多 MAX_TRACK_LIMIT。
 */
function parseTrackLimit(c: Context, key = "trackLimit"): number {
  const raw = c.req.query(key) ?? "";
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(value, MAX_TRACK_LIMIT);
}

/** 解析 `ids=a,b,c`。去重、截断到 SNAPSHOT_MAX_IDS，非法项直接跳过。 */
function parseSnapshotIDs(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "" || id.length > 128 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
    if (ids.length >= SNAPSHOT_MAX_IDS) {
      break;
    }
  }
  return ids;
}

interface SnapshotPlatform {
  playlists: AgentPlaylist[];
  favorites: AgentTrack[];
  details: AgentPlaylistDetail[];
  /** 平台级失败（未登录/会话失效）。空串表示这个平台的数据可用。 */
  error: string;
}

/**
 * 拉一个平台的快照。整体失败（未登录、凭证失效）时只回 `error`，不抛异常——
 * 另一个平台与后续的签名响应都要照常返回。
 *
 * 收藏失败降级为空数组：它不影响歌单同步，下一轮会重新取。
 */
async function platformSnapshot(
  store: AgentStore,
  platform: Platform,
  limit: number,
  trackLimit: number,
  ids: string[],
): Promise<SnapshotPlatform> {
  try {
    return await withPlatform(store, platform, async (credential) => {
      const detail = async (id: string): Promise<AgentPlaylistDetail | null> => {
        try {
          return platform === "qq"
            ? await fetchQQPlaylistDetail(new QQClient(credential), id, trackLimit)
            : await fetchNeteasePlaylistDetail(new NeteaseClient(credential), id, trackLimit);
        } catch {
          // 单张歌单失败（被删/上游限流）不让整批失败，服务端下一轮会再要。
          return null;
        }
      };
      const [playlists, favorites, details] = await Promise.all([
        platform === "qq"
          ? fetchQQPlaylists(new QQClient(credential), limit)
          : fetchNeteasePlaylists(new NeteaseClient(credential), limit),
        (platform === "qq"
          ? fetchQQFavorites(new QQClient(credential), limit)
          : fetchNeteaseFavorites(new NeteaseClient(credential), limit)
        ).catch(() => [] as AgentTrack[]),
        mapLimit(ids, SNAPSHOT_CONCURRENCY, detail),
      ]);
      return {
        playlists,
        favorites,
        details: details.filter((item): item is AgentPlaylistDetail => item !== null),
        error: "",
      };
    });
  } catch (error) {
    return {
      playlists: [],
      favorites: [],
      details: [],
      error: error instanceof AgentError ? error.publicMessage : "平台调用失败",
    };
  }
}

/** 并发受限的 map：保持结果顺序，最多 limit 个同时在飞。 */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

async function withPlatform<T>(
  store: AgentStore,
  platform: Platform,
  action: (credential: string) => Promise<T>,
): Promise<T> {
  const row = store.platform(platform);
  if (!row || row.status === "logged_out") {
    throw conflict("平台尚未登录");
  }
  let credentials: { credential: string; accountId: string } | null;
  try {
    credentials = await store.credentials(platform);
  } catch {
    throw conflict("平台会话不可用，请重新登录");
  }
  if (!credentials || credentials.credential === "") {
    throw conflict("平台尚未登录");
  }
  return action(credentials.credential);
}
