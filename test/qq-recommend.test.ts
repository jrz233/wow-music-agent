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
      if (call.method === "uniform_get_Dissinfo") {
        return { dirinfo: { id: "222", title: "每日30首" }, songlist: [SONG] };
      }
      return new Error("unexpected");
    });

    const tracks = await fetchDaily(new QQClient("uin=12345; qm_keyst=k"), 10);

    // 模块名必须是不带 Server 后缀的 RecommendFeed：带后缀的那个返回 code != 0。
    expect(calls[0]?.module).toBe("music.recommend.RecommendFeed");
    expect(calls[0]?.method).toBe("get_recommend_feed");
    // 第二次调用用的是卡片里拿到的歌单 id，不是把卡片当曲目硬解。
    expect(calls[1]?.module).toBe("music.srfDissInfo.aiDissInfo");
    expect(calls[1]?.method).toBe("uniform_get_Dissinfo");
    expect(calls[1]?.param.disstid).toBe("222");
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
});
