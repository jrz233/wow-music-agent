/**
 * 网易云歌单详情取全：大歌单的 `tracks` 常常只带一部分（甚至为空），
 * 完整顺序在 `trackIds` 里——缺的部分要按 id 补取，且只补到请求条数。
 */

import { describe, expect, it } from "vitest";
import { clampTrackLimit, fetchPlaylistDetail } from "../src/netease/api";

interface Call {
  path: string;
  payload: Record<string, unknown>;
}

function song(id: string): Record<string, unknown> {
  return {
    id,
    name: `歌 ${id}`,
    ar: [{ id: "artist-1", name: "歌手" }],
    al: { id: "album-1", name: "专辑" },
    dt: 180000,
  };
}

/**
 * 假上游：`v6/playlist/detail` 只回 `inline` 首曲目 + 全部 `trackIds`；
 * `v3/song/detail` 按 id 回曲目。
 */
function fakeClient(total: number, inline: number): { client: Parameters<typeof fetchPlaylistDetail>[0]; calls: Call[] } {
  const calls: Call[] = [];
  const trackIds = Array.from({ length: total }, (_, index) => ({ id: index + 1 }));
  const client = {
    call: async (path: string, payload: Record<string, unknown> = {}) => {
      calls.push({ path, payload });
      if (path === "v6/playlist/detail") {
        return {
          playlist: {
            id: "42",
            name: "大歌单",
            trackCount: total,
            trackIds,
            tracks: trackIds.slice(0, inline).map((item) => song(String(item.id))),
          },
        };
      }
      if (path === "v3/song/detail") {
        const ids = JSON.parse(String(payload.c)) as { id: string }[];
        return { songs: ids.map((item) => song(item.id)) };
      }
      throw new Error(`unexpected call ${path}`);
    },
  };
  return { client: client as unknown as Parameters<typeof fetchPlaylistDetail>[0], calls };
}

describe("网易云歌单详情补取", () => {
  it("tracks 为空时按 trackIds 取全 450 首", async () => {
    const { client, calls } = fakeClient(450, 0);
    const detail = await fetchPlaylistDetail(client, "42", 1000);
    expect(detail.tracks).toHaveLength(450);
    expect(detail.tracks[0]?.id).toBe("1");
    expect(detail.tracks.at(-1)?.id).toBe("450");
    // 200 个 id 一批，450 首分三批。
    expect(calls.filter((call) => call.path === "v3/song/detail")).toHaveLength(3);
  });

  it("tracks 只带一部分时补上剩余的", async () => {
    const { client } = fakeClient(450, 50);
    const detail = await fetchPlaylistDetail(client, "42", 1000);
    expect(detail.tracks).toHaveLength(450);
  });

  it("只请求 100 首时不会把整张歌单都取回来", async () => {
    const { client } = fakeClient(450, 50);
    const detail = await fetchPlaylistDetail(client, "42", 100);
    expect(detail.tracks).toHaveLength(100);
  });

  it("limit 收敛到协议上限", () => {
    expect(clampTrackLimit(5000)).toBe(1000);
    expect(clampTrackLimit(250)).toBe(250);
  });
});
