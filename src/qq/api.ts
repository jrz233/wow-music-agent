/**
 * QQ 音乐数据面。
 *
 * QQ 的 musicu 返回字段在不同模块/版本里差异很大（`v_list` vs `list`、
 * `track_info` 包一层 vs 直接把曲目字段铺平）。这里集中做多路兼容，并保证输出
 * 只包含 Agent 的语义化字段。**宁可少返回，也不把平台原始对象透传。**
 */

import type { AgentPlaylist, AgentPlaylistDetail, AgentTrack } from "../shared/types";
import { unavailable } from "../shared/errors";
import { QQClient } from "./client";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * 用户歌单 = 自建 + 收藏。
 *
 * 以前用 `music.musichallSongListServer/GetUserMusicList`，那个模块对当前客户端
 * 版本已经不可用（恒回 `500003`）。正确的一对是：
 *   - 自建：`music.musicasset.PlaylistBaseRead/GetPlaylistByUin`
 *   - 收藏：`music.musicasset.PlaylistFavRead/GetPlaylistFavInfo`
 * 两者的响应结构也不同（`v_playlist` 用 `dirName`，`v_list` 用 `name`）。
 */
export async function fetchPlaylists(client: QQClient, limit = DEFAULT_LIMIT): Promise<AgentPlaylist[]> {
  const uin = client.uin;
  const created = await client.call("music.musicasset.PlaylistBaseRead", "GetPlaylistByUin", { uin });
  const liked = await client
    .call("music.musicasset.PlaylistFavRead", "GetPlaylistFavInfo", { uin })
    .catch(() => ({}));
  const merged = [
    ...firstArray(created, ["v_playlist", "v_list"]).map(mapPlaylist),
    ...firstArray(liked, ["v_list", "v_playlist"]).map(mapPlaylist),
  ].filter((item) => item.id !== "");
  const seen = new Set<string>();
  const unique = merged.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  return unique.slice(0, clampLimit(limit));
}

/**
 * 歌单详情。
 *
 * 优先 `music.srfDissInfo.DissInfo/CgiGetDiss`：它是当前客户端仍在用的稳定模块，
 * 对自建歌单与「我喜欢」都可用。`music.srfDissInfo.aiDissInfo/uniform_get_Dissinfo`
 * 作为兜底——新模块对部分歌单（例如每日推荐）更宽，但对旧客户端身份会回 10006。
 * 两个响应结构一致（`dirinfo` + `songlist`），映射只写一份。
 */
export async function fetchPlaylistDetail(
  client: QQClient,
  id: string,
  limit = DEFAULT_LIMIT,
): Promise<AgentPlaylistDetail> {
  const num = clampLimit(limit);
  const numericID = Number(id);
  const page = {
    song_begin: 0,
    song_num: num,
  };
  let data: Record<string, unknown>;
  try {
    data = await client.call("music.srfDissInfo.DissInfo", "CgiGetDiss", {
      disstid: Number.isFinite(numericID) && numericID > 0 ? numericID : id,
      dirid: 0,
      tag: 1,
      userinfo: 1,
      orderlist: 1,
      onlysonglist: 0,
      ...page,
    });
  } catch {
    data = await client.call("music.srfDissInfo.aiDissInfo", "uniform_get_Dissinfo", {
      disstid: id,
      userinfo: 1,
      tag: 1,
      orderlist: 1,
      onlysonglist: 0,
      enc_host_uin: "",
      ...page,
    });
  }
  const info = asRecord(data.dirinfo) ?? asRecord(data.info) ?? data;
  const tracks = firstArray(data, ["songlist", "songs", "list"])
    .map(mapTrack)
    .filter((item) => item.id !== "");
  return {
    ...mapPlaylist(info),
    id: text(info.dissid) || text(info.id) || text(info.dirId) || id,
    tracks: tracks.slice(0, num),
  };
}

/**
 * 「我喜欢的音乐」。
 *
 * QQ 的收藏不是独立接口，而是一张名为「我喜欢」的普通歌单（自建列表里）。
 * 以前按 `id === "201"` 猜——那是网易云的 `specialType` 语义，QQ 上没有这个 id。
 */
export async function fetchFavorites(client: QQClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  const uin = client.uin;
  const created = await client.call("music.musicasset.PlaylistBaseRead", "GetPlaylistByUin", { uin });
  const playlists = firstArray(created, ["v_playlist", "v_list"]).map(mapPlaylist);
  const liked = playlists.find((item) => item.name.includes("我喜欢"));
  if (!liked) {
    return [];
  }
  const detail = await fetchPlaylistDetail(client, liked.id, limit);
  return detail.tracks;
}

/**
 * 每日推荐。
 *
 * `get_recommend_feed` 返回的是**货架（shelf）结构**，不是曲目列表：里面是一堆
 * 推荐卡片，其中标题为「每日30首」的那张卡的 `id` 才是一张**歌单**的 id。直接
 * `extractTracks()` 在这个结构上永远得到空数组——这就是「每日推荐拿不到」的原因。
 *
 * 因此两步：先取卡片拿 id，再按普通歌单拉曲目。模块名是 `RecommendFeed`
 * （没有 `Server` 后缀），带后缀的调用返回 code != 0。
 */
export async function fetchDaily(client: QQClient, limit = DEFAULT_LIMIT): Promise<AgentTrack[]> {
  const feed = await client.call("music.recommend.RecommendFeed", "get_recommend_feed", {
    direction: 0,
    page: 1,
    v_cache: [],
    v_uniq: [],
    s_num: 0,
  });
  const playlistID = dailyPlaylistID(feed);
  if (!playlistID) {
    return [];
  }
  let tracks: AgentTrack[];
  let playlistError = "";
  try {
    tracks = (await fetchPlaylistDetail(client, playlistID, clampLimit(limit))).tracks;
  } catch (error) {
    // 「每日30首」卡片给的是**排行榜 id**（通常 ≤1000），不是普通歌单 id：
    // 拿它去 `uniform_get_Dissinfo` 会回 10006。排行榜走 ToplistInfoServer。
    playlistError = error instanceof Error ? error.message : String(error);
    try {
      tracks = (await fetchToplistDetail(client, playlistID, clampLimit(limit))).tracks;
    } catch (toplistError) {
      const toplistMessage = toplistError instanceof Error ? toplistError.message : String(toplistError);
      throw unavailable(
        `每日推荐卡片 ${playlistID} 拉取失败（歌单：${playlistError}；排行榜：${toplistMessage}）`,
      );
    }
  }
  return tracks.slice(0, clampLimit(limit));
}

/**
 * 排行榜详情。
 *
 * 只用于「每日30首」这类以排行榜 id 下发的推荐歌单；用户自己的歌单
 * （含「我喜欢」）仍然是普通 disstid，不能按 id 大小猜类型。
 */
export async function fetchToplistDetail(
  client: QQClient,
  id: string,
  limit = DEFAULT_LIMIT,
): Promise<AgentPlaylistDetail> {
  const data = await client.call("musicToplist.ToplistInfoServer", "GetDetail", {
    topid: Number(id) || id,
    offset: 0,
    num: clampLimit(limit),
    period: "",
  });
  const info = asRecord(data.data) ?? data;
  const tracks = firstArray(data, ["songInfoList", "songlist", "songs", "list"])
    .map(mapTrack)
    .filter((item) => item.id !== "");
  return {
    id: text(info.topId) || text(info.id) || id,
    name: text(info.title) || text(info.name),
    description: text(info.intro) || text(info.desc),
    coverUrl: text(info.mbFrontPicUrl) || text(info.headPicUrl) || text(info.picurl) || "",
    trackCount: integer(info.totalNum) || integer(info.songnum) || tracks.length,
    playCount: integer(info.listenNum) || integer(info.listen_num) || 0,
    tags: [],
    createdAt: null,
    updatedAt: seconds(info.updateTime) ?? null,
    tracks: tracks.slice(0, clampLimit(limit)),
  };
}

/** 从货架结构里找出「每日30首」卡片的 id（歌单 id）。 */
export function dailyPlaylistID(feed: Record<string, unknown>): string {
  // 卡片不一定在第一格：未登录/新账号时货架顺序会变，[0] 常是运营位。
  // 所以遍历全部 shelf 与 niche，按标题找，而不是只取 `[0][0]`。
  const shelves = firstArray(feed, ["v_shelf"]);
  for (const shelf of shelves) {
    const record = asRecord(shelf);
    if (!record) continue;
    for (const niche of firstArray(record, ["v_niche"])) {
      const nicheRecord = asRecord(niche);
      if (!nicheRecord) continue;
      for (const card of firstArray(nicheRecord, ["v_card"])) {
        const cardRecord = asRecord(card);
        if (!cardRecord) continue;
        if (text(cardRecord.title) === "每日30首") {
          const id = text(cardRecord.id);
          if (id) return id;
        }
      }
    }
  }
  return "";
}

/**
 * 漫游。
 *
 * - `radar`：雷达（`GetRadarSong`），是平台按听歌关系推的「雷达歌单」；
 * - `radio`：刷歌，也就是 QQ 客户端的「猜你喜欢」电台（固定 `id: 99`）。
 *
 * `style` 只影响 radio：上游电台本身没有口味参数，这里用「我喜欢」里的歌手集合
 * 给返回曲目重排——`familiar` 熟悉歌手优先，`fresh` 陌生歌手优先，`balanced`
 * 保持平台原序。
 */
export async function fetchRoam(
  client: QQClient,
  mode: string,
  limit = DEFAULT_LIMIT,
  style = "balanced",
): Promise<AgentTrack[]> {
  const size = clampLimit(limit);
  if (mode === "radar") {
    // 雷达的参数是固定的 `Page/NeedNum/ReqType`；`VecSongs[].Track` 才是曲目。
    // 以前传 `PageSize/From` 属于另一个接口的字段，服务端只当没收到，于是空数组。
    const data = await client.call("music.recommend.TrackRelationServer", "GetRadarSong", {
      LastToastTime: Date.now(),
      NeedNum: 149,
      Page: 1,
      ReqType: 0,
    });
    const songs = Array.isArray(data.VecSongs) ? data.VecSongs : [];
    return songs
      .map((item) => asRecord(asRecord(item)?.Track))
      .filter(Boolean)
      .map((item) => mapTrack(item))
      .filter((item) => item.id !== "")
      .slice(0, size);
  }
  // radio（刷歌）：单次只返回几首，循环累积；最多 5 次上游调用，与 wow-server 的计划一致。
  //
  // `id: 99` 是「猜你喜欢」这个电台的固定 id；`firstplay` 必须显式给 0。
  // 之前传的是 `song_num/play_flag`，服务端忽略掉 id 后落到了默认电台——
  // 于是「刷歌」返回的全是助眠歌单里的曲目。
  const result: AgentTrack[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < 5 && result.length < size; round += 1) {
    const data = await client.call("music.radioProxy.MbTrackRadioSvr", "get_radio_track", {
      id: 99,
      firstplay: 0,
      num: Math.min(5, size - result.length),
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
  return orderByGuessStyle(result, await favoriteArtists(client, style), style).slice(0, size);
}

/**
 * 返回「我喜欢」里出现过的歌手 id 集合；取巧失败时返回空集合（保持平台原序）。
 * 只有 familiar / fresh 才需要，balanced 不额外发请求。
 */
async function favoriteArtists(client: QQClient, style: string): Promise<Set<string>> {
  if (style !== "familiar" && style !== "fresh") {
    return new Set();
  }
  try {
    const tracks = await fetchFavorites(client, MAX_LIMIT);
    const artists = new Set<string>();
    for (const track of tracks) {
      for (const artist of track.artists) {
        if (artist.id) artists.add(artist.id);
      }
    }
    return artists;
  } catch {
    return new Set();
  }
}

/** orderByGuessStyle 按熟悉/陌生重排；同分保持平台原序（Array#sort 在 Node 20+ 稳定）。 */
function orderByGuessStyle(tracks: AgentTrack[], known: Set<string>, style: string): AgentTrack[] {
  if (style !== "familiar" && style !== "fresh") {
    return tracks;
  }
  const familiarFirst = style === "familiar";
  return tracks
    .map((track, index) => ({
      track,
      index,
      familiar: track.artists.some((artist) => artist.id !== "" && known.has(artist.id)),
    }))
    .sort((left, right) => {
      if (left.familiar !== right.familiar) {
        return familiarFirst === left.familiar ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((item) => item.track);
}

export function mapPlaylist(raw: unknown): AgentPlaylist {
  const value = asRecord(raw) ?? {};
  const tags = [
    ...stringArray(value.tag),
    ...stringArray(value.tagList),
    ...stringArray(value.tagNameList),
    ...stringArray(value.tags),
  ];
  return {
    // `tid` 才是歌单详情接口认的 id。`dirId` 是账号内部目录号（「我喜欢」是 201），
    // 拿它去 srfDissInfo 会回 `-100006 get diss info from tmem error`。
    id: text(value.dissid) || text(value.tid) || text(value.id) || text(value.dirId),
    name: text(value.diss_name) || text(value.dirName) || text(value.name) || text(value.title),
    description: text(value.diss_desc) || text(value.desc) || text(value.introduction),
    coverUrl:
      text(value.diss_cover) ||
      text(value.dirPicUrl) ||
      text(value.picurl) ||
      text(value.picUrl) ||
      text(value.logo) ||
      text(value.cover),
    trackCount:
      integer(value.song_cnt) ||
      integer(value.songNum) ||
      integer(value.songnum) ||
      integer(value.total_song_num),
    playCount: integer(value.listen_num) || integer(value.playCount) || integer(value.visitnum),
    tags: [...new Set(tags)],
    createdAt: seconds(value.create_time) ?? seconds(value.createTime) ?? seconds(value.ctime),
    updatedAt: seconds(value.update_time) ?? seconds(value.updateTime) ?? seconds(value.mtime),
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
