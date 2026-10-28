/**
 * QQ 音乐数据面。
 *
 * QQ 的 musicu 返回字段在不同模块/版本里差异很大（`v_list` vs `list`、
 * `track_info` 包一层 vs 直接把曲目字段铺平）。这里集中做多路兼容，并保证输出
 * 只包含 Agent 的语义化字段。**宁可少返回，也不把平台原始对象透传。**
 */

import type { AgentPlaylist, AgentPlaylistDetail, AgentTrack } from "../shared/types";
import { QQClient } from "./client";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function fetchPlaylists(client: QQClient, limit = DEFAULT_LIMIT): Promise<AgentPlaylist[]> {
  const data = await client.call("music.musichallSongListServer", "GetUserMusicList", {
    uin: client.uin,
    offset: 0,
    limit: 100,
    order: 0,
  });
  const lists = firstArray(data, ["v_list", "list", "disslist", "data"]);
  return lists.map(mapPlaylist).filter((item) => item.id !== "").slice(0, clampLimit(limit));
}

export async function fetchPlaylistDetail(
  client: QQClient,
  id: string,
  limit = DEFAULT_LIMIT,
): Promise<AgentPlaylistDetail> {
  const data = await client.call("music.srfDissInfo.DissInfo", "CgiGetDiss", {
    disstid: id,
    dirid: 0,
    tag: 1,
    song_begin: 0,
    song_num: clampLimit(limit),
    userinfo: 1,
  });
  const info = asRecord(data.dirinfo) ?? asRecord(data.info) ?? data;
  const tracks = firstArray(data, ["songlist", "songs", "list"])
    .map(mapTrack)
    .filter((item) => item.id !== "");
  return {
    ...mapPlaylist(info),
    id: text(info.dissid) || text(info.dirId) || id,
    tracks: tracks.slice(0, clampLimit(limit)),
  };
}

export async function fetchFavorites(client: QQClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  const playlists = await fetchPlaylists(client, MAX_LIMIT);
  const liked =
    playlists.find((item) => item.id === "201") ??
    playlists.find((item) => item.name.includes("喜欢"));
  if (!liked) {
    return [];
  }
  const detail = await fetchPlaylistDetail(client, liked.id, limit);
  return detail.tracks;
}

export async function fetchDaily(client: QQClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  const first = await client
    .call("music.recommend.RecommendFeedServer", "get_recommend_feed", {
      direction: 0,
      page: 0,
      v_cache: 0,
      uin: client.uin,
    })
    .catch(() => ({}));
  let tracks = extractTracks(first).map(mapTrack);
  if (tracks.length === 0) {
    const second = await client
      .call("music.recommend.RecommendSonglistServer", "get_recommend_songlist", {
        direction: 0,
        page: 0,
        uin: client.uin,
      })
      .catch(() => ({}));
    tracks = extractTracks(second).map(mapTrack);
  }
  return tracks.filter((item) => item.id !== "").slice(0, clampLimit(limit));
}

export async function fetchRoam(
  client: QQClient,
  mode: string,
  limit = DEFAULT_LIMIT,
): Promise<AgentTrack[]> {
  const size = clampLimit(limit);
  if (mode === "radar") {
    const data = await client.call("music.recommend.TrackRelationServer", "GetRadarSong", {
      PageSize: size,
      From: "",
      uin: client.uin,
    });
    return extractTracks(data).map(mapTrack).slice(0, size);
  }
  // radio（刷歌）：单次只返回几首，循环累积；最多 5 次上游调用，与 wow-server 的计划一致。
  const result: AgentTrack[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < 5 && result.length < size; round += 1) {
    const data = await client.call("music.radioProxy.MbTrackRadioSvr", "get_radio_track", {
      song_num: size - result.length,
      uin: client.uin,
      play_flag: 1,
    });
    const batch = extractTracks(data).map(mapTrack);
    let added = 0;
    for (const track of batch) {
      if (!track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      result.push(track);
      added += 1;
    }
    if (added === 0) break;
  }
  return result.slice(0, size);
}

export function mapPlaylist(raw: unknown): AgentPlaylist {
  const value = asRecord(raw) ?? {};
  const tags = [
    ...stringArray(value.tag),
    ...stringArray(value.tagList),
    ...stringArray(value.tags),
  ];
  return {
    id: text(value.dissid) || text(value.dirId) || text(value.tid) || text(value.id),
    name: text(value.diss_name) || text(value.dirName) || text(value.name) || text(value.title),
    description: text(value.diss_desc) || text(value.desc) || text(value.introduction),
    coverUrl:
      text(value.diss_cover) ||
      text(value.dirPicUrl) ||
      text(value.picurl) ||
      text(value.cover),
    trackCount:
      integer(value.song_cnt) ||
      integer(value.songNum) ||
      integer(value.songnum) ||
      integer(value.total_song_num),
    playCount: integer(value.listen_num) || integer(value.playCount) || integer(value.visitnum),
    tags: [...new Set(tags)],
    createdAt: seconds(value.create_time) ?? seconds(value.ctime),
    updatedAt: seconds(value.update_time) ?? seconds(value.mtime),
  };
}

export function mapTrack(raw: unknown): AgentTrack {
  const entry = asRecord(raw) ?? {};
  const wrapped = asRecord(entry.track_info) ?? entry;
  const value = wrapped;
  const album = asRecord(value.album);
  const albumMid = text(album?.mid) || text(value.albummid) || text(value.albumMid);
  const albumId = text(album?.id) || albumMid || text(value.albumid);
  const artists = [value.singer, value.singers, value.artist]
    .flatMap((artist) => (Array.isArray(artist) ? artist : artist ? [artist] : []))
    .map((item) => {
      const artist = asRecord(item) ?? {};
      return {
        id: text(artist.mid) || text(artist.id),
        name: text(artist.name) || text(artist.title),
      };
    })
    .filter((item) => item.name !== "");
  const cover =
    text(album?.coverUrl) ||
    text(album?.picurl) ||
    (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : "");
  return {
    id: text(value.mid) || text(value.songmid) || text(value.id),
    title: text(value.name) || text(value.title) || text(value.songname),
    artists,
    album: {
      id: albumId,
      name: text(album?.name) || text(album?.title) || text(value.albumname),
      coverUrl: cover,
    },
    durationMs: integer(value.interval) * 1000 || integer(value.durationMs),
    ...(integer(value.index_album) > 0 ? { trackNumber: integer(value.index_album) } : {}),
    ...(integer(value.disc) > 0 ? { discNumber: integer(value.disc) } : {}),
  };
}

/** 从任意一层的已知数组字段里抽曲目；用于推荐/漫游这类多形态响应。 */
function extractTracks(data: Record<string, unknown>): (Record<string, unknown> | undefined)[] {
  const direct = firstArray(data, ["songlist", "songs", "track_list", "tracks", "list", "recomPlaylist"]);
  if (direct.length > 0) {
    return direct.map((item) => asRecord(item)).filter(Boolean) as Record<string, unknown>[];
  }
  const cards = firstArray(data, ["cards", "data"]);
  for (const card of cards) {
    const record = asRecord(card);
    if (!record) continue;
    const nested = extractTracks(record);
    if (nested.length > 0) {
      return nested;
    }
  }
  return [];
}

export function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value as number), MAX_LIMIT);
}

function firstArray(data: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }
  return [];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = asRecord(item);
      return record ? text(record.name) || text(record.title) || text(record.id) : text(item);
    })
    .filter((item) => item !== "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
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

function seconds(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}
