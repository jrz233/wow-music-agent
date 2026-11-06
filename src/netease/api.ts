/**
 * 网易云数据面：把上游响应映射成 Agent 的**语义化**形状。
 *
 * 平台字段改名时就只改这一层；上层（`agent/v1.ts`）与 wow-server 都不认识
 * `ar/al/dt` 这类缩写。所有输出都会经过 `limit` 截断，绝不把整份歌单原样透传。
 *
 * 接口与加密方式对齐 wow-origin（`platforms/netease/module/*.js`）：
 * 歌单、详情、每日推荐走 eapi；Personal FM 走 weapi 并带上风控令牌。
 */

import type { AgentPlaylist, AgentPlaylistDetail, AgentTrack } from "../shared/types";
import { NeteaseClient } from "./client";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
/** 歌单详情单次最多返回的曲目数，与 `/v1` 协议的 trackLimit 上限一致。 */
const MAX_TRACK_LIMIT = 1000;
/** 曲目详情接口一次最多 200 个 id；并发取回，1000 首一轮就能发完。 */
const SONG_DETAIL_BATCH = 200;
const SONG_DETAIL_CONCURRENCY = 5;
/** Personal FM 一次只给几首，靠连问几轮凑队列。 */
const FM_ROUNDS = 3;

export async function fetchPlaylists(client: NeteaseClient, limit = DEFAULT_LIMIT): Promise<AgentPlaylist[]> {
  const account = await client.account();
  const data = await client.call("user/playlist", {
    uid: account.userId,
    limit: 1000,
    offset: 0,
    includeVideo: false,
  });
  const list = array(data.playlist);
  return list.map(mapPlaylist).filter((item) => item.id !== "").slice(0, clampLimit(limit));
}

export async function fetchPlaylistDetail(
  client: NeteaseClient,
  id: string,
  limit = DEFAULT_LIMIT,
): Promise<AgentPlaylistDetail> {
  const max = clampTrackLimit(limit);
  const data = await client.call("v6/playlist/detail", { id, n: 1000, s: 8 });
  const playlist = record(data.playlist);
  if (!playlist) {
    throw new Error("playlist missing");
  }
  const ids = array(playlist.trackIds)
    .map((item) => text(record(item)?.id))
    .filter((item) => item !== "")
    .slice(0, max);
  let resolved = array(playlist.tracks).map(mapTrack);
  // 大歌单的 `tracks` 常常只带一部分（甚至为空），完整顺序在 `trackIds` 里：
  // 缺的部分按 id 补取，最多补到请求条数。
  if (ids.length > resolved.length && resolved.length < max) {
    const missing = ids.slice(resolved.length, max);
    if (missing.length > 0) {
      resolved = resolved.concat(await fetchSongs(client, missing));
    }
  }
  return {
    ...mapPlaylist(playlist),
    tracks: resolved.slice(0, max),
  };
}

export async function fetchFavorites(client: NeteaseClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  const liked = await likedPlaylistID(client);
  if (!liked) {
    return [];
  }
  const detail = await fetchPlaylistDetail(client, liked, limit);
  return detail.tracks;
}

export async function fetchDaily(client: NeteaseClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  // 参考实现用的是 `/v1/discovery/recommend/songs`（不是 v2）。
  const data = await client.call("v1/discovery/recommend/songs", { limit: 100 });
  const inner = record(data.data) ?? data;
  return array(inner.dailySongs).map(mapTrack).slice(0, clampLimit(limit));
}

export async function fetchRoam(client: NeteaseClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  // Personal FM 走 weapi，并带风控令牌——少了会被判成爬虫。
  //
  // 上游**一次只给 3~5 首**，但每次调用都会往后翻（同一账号会话连着问，拿到的是
  // 不同的歌）。要凑够一队列就得连问几轮：每轮按 id 去重，一旦某轮没有新歌就停，
  // 免得上游返回重复内容时在这里空转。
  //
  // 轮数取 3：每轮约 1~2 秒（weapi 往返），3 轮足够凑出十几首，又不会把
  // wow-server 侧的读取超时顶穿。
  const size = clampLimit(limit);
  const result: AgentTrack[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < FM_ROUNDS && result.length < size; round += 1) {
    const data = await client.callWeb("v1/radio/get", {}, { antiCheat: true });
    let added = 0;
    for (const track of array(data.data).map(mapTrack)) {
      if (!track.id || seen.has(track.id)) {
        continue;
      }
      seen.add(track.id);
      result.push(track);
      added += 1;
    }
    if (added === 0) {
      break;
    }
  }
  return result.slice(0, size);
}

async function likedPlaylistID(client: NeteaseClient): Promise<string> {
  const account = await client.account();
  const data = await client.call("user/playlist", {
    uid: account.userId,
    limit: 1000,
    offset: 0,
    includeVideo: false,
  });
  const playlists = array(data.playlist).map(record).filter(Boolean) as Record<string, unknown>[];
  const liked =
    playlists.find((item) => Number(item.specialType ?? 0) === 5) ??
    playlists.find((item) => item.subscribed === false && text(item.name).includes("喜欢"));
  return liked ? text(liked.id) : "";
}

async function fetchSongs(client: NeteaseClient, ids: string[]): Promise<AgentTrack[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += SONG_DETAIL_BATCH) {
    chunks.push(ids.slice(index, index + SONG_DETAIL_BATCH));
  }
  const pages = await mapLimit(chunks, SONG_DETAIL_CONCURRENCY, (chunk) =>
    client
      .call("v3/song/detail", { c: JSON.stringify(chunk.map((id) => ({ id }))) })
      .then((data) => array(data.songs).map(mapTrack)),
  );
  return pages.flat();
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

export function mapPlaylist(raw: unknown): AgentPlaylist {
  const value = record(raw) ?? {};
  return {
    id: text(value.id),
    name: text(value.name),
    description: text(value.description),
    coverUrl: text(value.coverImgUrl) || text(value.picUrl),
    trackCount: integer(value.trackCount),
    playCount: integer(value.playCount),
    tags: array(value.tags).map(text).filter((item) => item !== ""),
    createdAt: timestamp(value.createTime),
    updatedAt: timestamp(value.updateTime),
  };
}

export function mapTrack(raw: unknown): AgentTrack {
  const value = record(raw) ?? {};
  const album = record(value.al) ?? record(value.album);
  const artists = (array(value.ar).length > 0 ? array(value.ar) : array(value.artists)).map((item) => {
    const artist = record(item) ?? {};
    return { id: text(artist.id), name: text(artist.name) };
  });
  const aliases = array(value.alia).map(text).filter((item) => item !== "");
  return {
    id: text(value.id),
    title: text(value.name) || text(value.title),
    artists,
    album: {
      id: text(album?.id),
      name: text(album?.name),
      coverUrl: text(album?.picUrl) || text(album?.coverUrl),
    },
    durationMs: integer(value.dt) || integer(value.duration),
    ...(Number(value.no) > 0 ? { trackNumber: Number(value.no) } : {}),
    ...(Number(value.cd) > 0 ? { discNumber: Number(value.cd) } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(typeof value.fee === "number" ? { fee: Number(value.fee) !== 0 } : {}),
  };
}

/** 对调用方给出的 limit 做上限收敛；API 层永远不接受「不限量」。 */
export function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value as number), MAX_LIMIT);
}

/** 歌单曲目上限：与列表分开，最多 MAX_TRACK_LIMIT。 */
export function clampTrackLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value as number), MAX_TRACK_LIMIT);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function integer(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function timestamp(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number / 1000) : null;
}
