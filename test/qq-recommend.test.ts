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

/** 拦下 musicu 请求，记录 req_0，并按路径返回预设的 `data`。 */
function stubMusicu(handler: (call: Call) => Record<string, unknown> | Error): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
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
  return calls;
}

/** 一张最小可用的曲目，`mapTrack` 认得。id 取 `mid`（QQ 的曲目主键就是 songmid）。 */
const SONG = { mid: "song1", name: "歌名", singer: [{ mid: "s1", name: "歌手" }], interval: 200 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchDaily", () => {
  it("先用货架卡片找「每日30首」的歌单 id，再按歌单拉曲目", async () => {
    const calls = stubMusicu((call) => {
      if (call.method === "get_recommend_feed") {
        // 真实货架里「每日30首」不一定在第一格，挑卡必须扫全量。
        return {
          v_shelf: [
            { v_niche: [{ v_card: [{ title: "私人雷达", id: "111" }] }] },
            { v_niche: [{ v_card: [{ title: "每日30首", id: "222" }] }] },
          ],
        };
      }
      if (call.method === "CgiGetDiss") {
        return { dirinfo: { id: "222", title: "每日30首" }, songlist: [SONG] };
      }
      return new Error("unexpected");
    });

    const tracks = await fetchDaily(new QQClient("uin=12345; qm_keyst=k"), 10);

    // 模块名必须是不带 Server 后缀的 RecommendFeed：带后缀的那个返回 code != 0。
    expect(calls[0]?.module).toBe("music.recommend.RecommendFeed");
    expect(calls[0]?.method).toBe("get_recommend_feed");
    // 第二次调用用的是卡片里拿到的歌单 id，不是把卡片当曲目硬解。
    // 歌单详情优先走 CgiGetDiss：uniform_get_Dissinfo 对当前客户端会回 10006。
    expect(calls[1]?.module).toBe("music.srfDissInfo.DissInfo");
    expect(calls[1]?.method).toBe("CgiGetDiss");
    expect(calls[1]?.param.disstid).toBe(222);
    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
  });

  it("「每日30首」是排行榜 id 时改用 ToplistInfoServer 拉曲目", async () => {
    // 线上实际形态：两个歌单模块对这张卡片的 id 都回 10006。
    const calls = stubMusicu((call) => {
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
    stubMusicu((call) => {
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
    });

    const tracks = await fetchDaily(new QQClient("uin=12345; qm_keyst=k"), 10);
    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
  });

  it("没有「每日30首」卡片时返回空数组，而不是瞎猜一个 id", async () => {
    stubMusicu(() => ({ v_shelf: [{ v_niche: [{ v_card: [{ title: "私人雷达", id: "111" }] }] }] }));
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
    const calls = stubMusicu((call) => {
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
    const calls = stubMusicu(() => ({ tracks: [SONG] }));

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
      stubMusicu((call) => {
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
    const calls = stubMusicu(() => ({ tracks: [SONG] }));

    const tracks = await fetchRoam(new QQClient("uin=12345"), "radio", 10, "balanced");

    expect(tracks.map((track) => track.id)).toEqual(["song1"]);
    expect(calls.some((call) => call.method === "GetPlaylistByUin")).toBe(false);
  });
});
