/**
 * QQ 每日推荐 / 漫游的**契约**测试。
 *
 * 这三个接口都踩过「模块名或参数名写错、但服务端仍然 200 返回空数据」的坑：
 * 拿不到数据却没有任何报错，面板上只表现为「回退本地」。所以这里不断言字段映射
 * （那是 `mapTrack` 的事，已有用例），只钉死**打出去的模块名、方法名与参数**：
 * 只要有人把 `RecommendFeed` 改回 `RecommendFeedServer`，或用错 `Page/NeedNum`，
 * 用例就会红。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { dailyPlaylistID, fetchDaily, fetchRoam } from "../src/qq/api";
import { QQClient } from "../src/qq/client";

/** 8 字节 PNG 魔数占位，仅用于满足扫码用例。 */
interface Call {
  module: string;
  method: string;
  param: Record<string, unknown>;
}

interface Stub {
  calls: Call[];
  legacy: URL[];
}

/**
 * 拦下 QQ 的两类请求：
 *   - `musicu.fcg`（POST，按 `req_0` 记录调用并返回预设 `data`）；
 *   - 旧版歌单 CGI `c.y.qq.com`（GET，由 `legacy` 处理；未提供时按上游失败返回）。
 */
function stubQQ(
  handler: (call: Call) => Record<string, unknown> | Error,
  legacy?: (url: URL) => Record<string, unknown> | Error,
): Stub {
  const calls: Call[] = [];
  const legacyCalls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "c.y.qq.com") {
        legacyCalls.push(url);
        const result = legacy?.(url) ?? new Error("unexpected legacy call");
        if (result instanceof Error) {
          return new Response(JSON.stringify({ code: -1, cdlist: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        req_0?: { module?: string; method?: string; param?: Record<string, unknown> };
      };
      const call: Call = {
        module: payload.req_0?.module ?? "",
        method: payload.req_0?.method ?? "",
        param: payload.req_0?.param ?? {},
      };
      calls.push(call);
      const result = handler(call);
      if (result instanceof Error) {
        return new Response(JSON.stringify({ code: 0, req_0: { code: -1 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, req_0: { code: 0, data: result } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return { calls, legacy: legacyCalls };
}

/** 一张最小可用的曲目，`mapTrack` 认得。id 取 `mid`（QQ 的曲目主键就是 songmid）。 */
const SONG = { mid: "song1", name: "歌名", singer: [{ mid: "s1", name: "歌手" }], interval: 200 };
/** 旧版 cdlist 接口的曲目形态：字段是平铺的 `songmid` / `songname` / `albummid`。 */
const LEGACY_SONG = {
  id: 1,
  songmid: "daily-mid",
  songname: "每日歌曲",
  singer: [{ mid: "artist-mid", name: "歌手" }],
  albumname: "专辑",
  albummid: "album-mid",
  interval: 180,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchDaily", () => {
  it("「每日30首」走旧版 cdlist 接口拉「今日私享」歌单", async () => {
    const { calls, legacy } = stubQQ(
      (call) => {
        if (call.method === "get_recommend_feed") {
          // 真实货架里「每日30首」不一定在第一格，挑卡必须扫全量。
          return {
            v_shelf: [
              { v_niche: [{ v_card: [{ title: "私人雷达", id: "111" }] }] },
              { v_niche: [{ v_card: [{ title: "每日30首", id: "222" }] }] },
            ],
          };
        }
        return new Error("unexpected");
      },
      (url) => {
        // 卡片 id 是「今日私享」歌单，普通歌单接口对它回 10006。
        expect(url.searchParams.get("disstid")).toBe("222");
        return {
          code: 0,
          cdlist: [{ disstid: "222", dissname: "今日私享", songnum: 1, songlist: [LEGACY_SONG] }],
        };
      },
    );

    const tracks = await fetchDaily(new QQClient("uin=12345; qm_keyst=k"), 10);

    // 模块名必须是不带 Server 后缀的 RecommendFeed：带后缀的那个返回 code != 0。
    expect(calls[0]?.module).toBe("music.recommend.RecommendFeed");
    expect(calls[0]?.method).toBe("get_recommend_feed");
    // 日推只发一次 cdlist，不再去试 CgiGetDiss / uniform_get_Dissinfo。
    expect(calls.map((call) => call.method)).toEqual(["get_recommend_feed"]);
    expect(legacy).toHaveLength(1);
    // 旧版响应的平铺字段也要能映射成 AgentTrack。
    expect(tracks).toEqual([
      {
        id: "daily-mid",
        title: "每日歌曲",
        artists: [{ id: "artist-mid", name: "歌手" }],
        album: {
          id: "album-mid",
          name: "专辑",
          coverUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg",
        },
        durationMs: 180_000,
      },
    ]);
  });

  it("旧版 cdlist 取不到时回退普通歌单接口", async () => {
    const { calls } = stubQQ(
      (call) => {
        if (call.method === "get_recommend_feed") {
          return { v_shelf: [{ v_niche: [{ v_card: [{ title: "每日30首", id: "222" }] }] }] };
        }
        if (call.method === "CgiGetDiss") {
          return { dirinfo: { id: "222", title: "每日30首" }, songlist: [SONG] };
        }
        return new Error("unexpected");
      },
      () => ({ code: 0, cdlist: [] }),
    );

    const tracks = await fetchDaily(new QQClient("uin=12345; qm_keyst=k"), 10);

    expect(calls.map((call) => call.method)).toEqual(["get_recommend_feed", "CgiGetDiss"]);
    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
  });

  it("「每日30首」是排行榜 id 时改用 ToplistInfoServer 拉曲目", async () => {
    // 线上实际形态：旧版接口与两个歌单模块对这张卡片的 id 都取不到。
    const { calls } = stubQQ((call) => {
      if (call.method === "get_recommend_feed") {
        return { v_shelf: [{ v_niche: [{ v_card: [{ title: "每日30首", id: "202" }] }] }] };
      }
      if (call.method === "CgiGetDiss" || call.method === "uniform_get_Dissinfo") {
        return new Error("10006");
      }
      if (call.method === "GetDetail") {
        return { data: { topId: 202, title: "每日30首", totalNum: 30 }, songInfoList: [SONG] };
      }
      return new Error("unexpected");
    });

    const tracks = await fetchDaily(new QQClient("uin=12345; qm_keyst=k"), 10);

    expect(calls.map((call) => call.method)).toEqual([
      "get_recommend_feed",
      "CgiGetDiss",
      "uniform_get_Dissinfo",
      "GetDetail",
    ]);
    expect(calls[2]?.module).toBe("music.srfDissInfo.aiDissInfo");
    expect(calls[3]?.module).toBe("musicToplist.ToplistInfoServer");
    expect(calls[3]?.param.topid).toBe(202);
    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
  });

  it("CgiGetDiss 不可用时回退 uniform_get_Dissinfo", async () => {
    stubQQ(
      (call) => {
        if (call.method === "get_recommend_feed") {
          return { v_shelf: [{ v_niche: [{ v_card: [{ title: "每日30首", id: "222" }] }] }] };
        }
        if (call.method === "CgiGetDiss") {
          return new Error("10006");
        }
        if (call.method === "uniform_get_Dissinfo") {
          return { dirinfo: { id: "222", title: "每日30首" }, songlist: [SONG] };
        }
        return new Error("unexpected");
      },
      () => ({ code: 0, cdlist: [] }),
    );

    const tracks = await fetchDaily(new QQClient("uin=12345; qm_keyst=k"), 10);
    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
  });

  it("没有「每日30首」卡片时返回空数组，而不是瞎猜一个 id", async () => {
    stubQQ(() => ({ v_shelf: [{ v_niche: [{ v_card: [{ title: "私人雷达", id: "111" }] }] }] }));
    expect(await fetchDaily(new QQClient("uin=1"), 10)).toEqual([]);
  });
});

describe("dailyPlaylistID", () => {
  it("忽略其它卡片", () => {
    expect(
      dailyPlaylistID({
        v_shelf: [{ v_niche: [{ v_card: [{ title: "猜你喜欢", id: "999" }, { title: "每日30首", id: "42" }] }] }],
      }),
    ).toBe("42");
  });

  it("在后面的货架里也能找到", () => {
    expect(
      dailyPlaylistID({
        v_shelf: [
          { v_niche: [{ v_card: [{ title: "猜你喜欢", id: "999" }] }] },
          { v_niche: [{ v_card: [{ title: "每日30首", id: "42" }] }] },
        ],
      }),
    ).toBe("42");
  });

  it("结构缺失时返回空串", () => {
    expect(dailyPlaylistID({})).toBe("");
    expect(dailyPlaylistID({ v_shelf: [] })).toBe("");
  });
});

describe("fetchRoam", () => {
  it("radar 用 GetRadarSong 的固定参数，并从 VecSongs[].Track 取曲目", async () => {
    const { calls } = stubQQ((call) => {
      if (call.method === "GetRadarSong") {
        return { VecSongs: [{ Track: SONG }] };
      }
      return new Error("unexpected");
    });

    const tracks = await fetchRoam(new QQClient("uin=12345"), "radar", 10);

    expect(calls[0]?.module).toBe("music.recommend.TrackRelationServer");
    expect(calls[0]?.param).toMatchObject({ Page: 1, NeedNum: 149, ReqType: 0 });
    // 旧的错误字段不能回来。
    expect(calls[0]?.param).not.toHaveProperty("PageSize");
    expect(calls[0]?.param).not.toHaveProperty("From");
    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
  });

  it("radio 必须带 id=99 与 firstplay=0（否则落到默认电台，返回助眠歌单）", async () => {
    const { calls } = stubQQ(() => ({ tracks: [SONG] }));

    const tracks = await fetchRoam(new QQClient("uin=12345"), "radio", 10);

    expect(calls[0]?.module).toBe("music.radioProxy.MbTrackRadioSvr");
    expect(calls[0]?.method).toBe("get_radio_track");
    expect(calls[0]?.param).toMatchObject({ id: 99, firstplay: 0 });
    // 旧的错误字段不能回来。
    expect(calls[0]?.param).not.toHaveProperty("song_num");
    expect(calls[0]?.param).not.toHaveProperty("play_flag");
    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
  });

  it("熟悉口味把「我喜欢」里的歌手排到前面，尝鲜反过来", async () => {
    const familiarSong = {
      mid: "known",
      name: "常听的歌",
      singer: [{ mid: "known-artist", name: "熟悉歌手" }],
      interval: 200,
    };
    const freshSong = {
      mid: "unknown",
      name: "陌生的歌",
      singer: [{ mid: "other-artist", name: "陌生歌手" }],
      interval: 200,
    };
    const stub = () =>
      stubQQ((call) => {
        if (call.method === "get_radio_track") {
          // 平台原序：陌生的在前。
          return { tracks: [freshSong, familiarSong] };
        }
        if (call.method === "GetPlaylistByUin") {
          return { v_playlist: [{ dirName: "我喜欢", tid: 555 }] };
        }
        if (call.method === "CgiGetDiss") {
          return {
            dirinfo: { dissid: 555 },
            songlist: [{ mid: "liked", name: "收藏", singer: [{ mid: "known-artist", name: "熟悉歌手" }] }],
          };
        }
        return new Error("unexpected");
      });

    stub();
    const familiar = await fetchRoam(new QQClient("uin=12345"), "radio", 10, "familiar");
    expect(familiar.map((track) => track.id)).toEqual(["known", "unknown"]);

    stub();
    const fresh = await fetchRoam(new QQClient("uin=12345"), "radio", 10, "fresh");
    expect(fresh.map((track) => track.id)).toEqual(["unknown", "known"]);
  });

  it("均衡口味不额外拉「我喜欢」，保持平台原序", async () => {
    const { calls } = stubQQ(() => ({ tracks: [SONG] }));

    const tracks = await fetchRoam(new QQClient("uin=12345"), "radio", 10, "balanced");

    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
    expect(calls.some((call) => call.method === "GetPlaylistByUin")).toBe(false);
  });
});
