/**
 * 歌单详情取全：上游单页只给 200 首时，`fetchPlaylistDetail` 要按 song_begin
 * 翻页把整张歌单取回来，而不是停在第一页。
 */

import { describe, expect, it } from "vitest";
import { clampTrackLimit, fetchPlaylistDetail } from "../src/qq/api";

interface Call {
  module: string;
  param: Record<string, unknown>;
}

/** 假上游：单页最多 200 首，按 song_begin/song_num 切一张 `total` 首的歌单。 */
function fakeClient(
  total: number,
  pageCap = 200,
): { client: Parameters<typeof fetchPlaylistDetail>[0]; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    call: async (module: string, _method: string, param: Record<string, unknown>) => {
      calls.push({ module, param });
      const begin = Number(param.song_begin ?? 0);
      const num = Number(param.song_num ?? 0);
      const end = Math.min(total, begin + Math.min(num, pageCap));
      const songlist = [];
      for (let index = begin; index < end; index += 1) {
        songlist.push({
          mid: `song-${index}`,
          name: `第 ${index + 1} 首`,
          singer: [{ mid: "singer-1", name: "歌手" }],
          album: { mid: "album-1", name: "专辑" },
          interval: 180,
        });
      }
      return {
        code: 0,
        dirinfo: { dissid: "123", diss_name: "大歌单", song_cnt: total },
        songlist,
      };
    },
  };
  return { client: client as unknown as Parameters<typeof fetchPlaylistDetail>[0], calls };
}

describe("QQ 歌单详情翻页", () => {
  it("请求 1000 首时按页取全 450 首", async () => {
    const { client, calls } = fakeClient(450);
    const detail = await fetchPlaylistDetail(client, "123", 1000);
    expect(detail.tracks).toHaveLength(450);
    // 顺序保持：翻页结果按首曲顺序拼接，不因并发打乱。
    expect(detail.tracks[0]?.id).toBe("song-0");
    expect(detail.tracks.at(-1)?.id).toBe("song-449");
    expect(detail.trackCount).toBe(450);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("上游把单页压到 100 首时也要取全", async () => {
    const { client } = fakeClient(230, 100);
    const detail = await fetchPlaylistDetail(client, "123", 1000);
    expect(detail.tracks).toHaveLength(230);
  });

  it("请求 50 首时只取一页，不多翻", async () => {
    const { client, calls } = fakeClient(450);
    const detail = await fetchPlaylistDetail(client, "123", 50);
    expect(detail.tracks).toHaveLength(50);
    expect(calls).toHaveLength(1);
  });

  it("limit 收敛到协议上限", () => {
    expect(clampTrackLimit(-1)).toBe(100);
    expect(clampTrackLimit(0)).toBe(100);
    expect(clampTrackLimit(5000)).toBe(1000);
    expect(clampTrackLimit(250)).toBe(250);
  });
});
