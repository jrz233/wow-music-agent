/**
 * 网易云数据面：把 weapi 的响应映射成 Agent 的**语义化**形状。
 *
 * 平台字段改名时就只改这一层；上层（`agent/v1.ts`）与 wow-server 都不认识
 * `ar/al/dt` 这类缩写。所有输出都会经过 `limit` 截断，绝不把整份歌单原样透传。
 */

import type { AgentPlaylist, AgentPlaylistDetail, AgentTrack } from "../shared/types";
import { NeteaseClient } from "./client";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

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
  const data = await client.call("v6/playlist/detail", { id, n: 1000, s: 8 });
  const playlist = record(data.playlist);
  if (!playlist) {
    throw new Error("playlist missing");
  }
  const tracks = array(playlist.tracks).map(mapTrack);
  let resolved = tracks;
  if (resolved.length === 0) {
    const ids = array(playlist.trackIds).map((item) => record(item)?.id).filter(Boolean) as (string | number)[];
    if (ids.length > 0) {
      resolved = await fetchSongs(client, ids.map(String));
    }
  }
  return {
    ...mapPlaylist(playlist),
    tracks: resolved.slice(0, clampLimit(limit)),
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
  const data = await client.call("v2/discovery/recommend/songs", {});
  const inner = record(data.data) ?? data;
  return array(inner.dailySongs).map(mapTrack).slice(0, clampLimit(limit));
}

export async function fetchRoam(client: NeteaseClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  const data = await client.call("v1/radio/get", {});
  return array(data.data).map(mapTrack).slice(0, clampLimit(limit));
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
  const result: AgentTrack[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200);
    const data = await client.call("v3/song/detail", {
      c: JSON.stringify(chunk.map((id) => ({ id }))),
    });
    result.push(...array(data.songs).map(mapTrack));
  }
  return result;
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
