/**
 * 网易云漫游（Personal FM）的**契约**测试。
 *
 * 上游 `v1/radio/get` 一次只回 3~5 首，而且只有同一账号会话连着问才会往后翻。
 * 所以 `fetchRoam` 要连问几轮、按 id 去重、凑够 limit 就停。这里钉死这三件事：
 * 少问一轮队列就太短，不去重会出现重复曲目，不判空就会在上游返回重复内容时空转。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRoam } from "../src/netease/api";
import { NeteaseClient } from "../src/netease/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 最小可用曲目：`mapTrack` 认 `id/name/ar/al/dt`。 */
function song(id: string) {
  return { id, name: `歌 ${id}`, ar: [{ id: `ar-${id}`, name: "歌手" }], al: { id: "al", name: "专辑" }, dt: 180_000 };
}

/**
 * 按顺序喂给 `v1/radio/get` 每轮的 `data`；记录每次请求，方便断言只问了几轮。
 * 多出来的调用会拿到最后一批，用来验证「没有新歌就提前退出」。
 */
function stubRadio(rounds: unknown[][]): { url: string; headers: Record<string, string> }[] {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const index = calls.length;
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const data = rounds[Math.min(index, rounds.length - 1)] ?? [];
      return new Response(JSON.stringify({ code: 200, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

describe("fetchRoam", () => {
  it("连问三轮并跨轮去重", async () => {
    const calls = stubRadio([
      [song("1"), song("2")],
      // 第二轮故意重复 "2"，只应留下 "3"。
      [song("2"), song("3")],
      [song("4")],
    ]);

    const tracks = await fetchRoam(new NeteaseClient("MUSIC_U=abc"), 100);

    expect(tracks.map((track) => track.id)).toEqual(["1", "2", "3", "4"]);
    // 三轮都问到了；第四轮不该发生。
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("/weapi/v1/radio/get");
    // Personal FM 必须带风控令牌，否则会被判成爬虫。
    expect(calls[0]?.headers["x-anticheattoken"]).toBeTruthy();
  });

  it("凑够 limit 就不再问了", async () => {
    const calls = stubRadio([[song("1"), song("2"), song("3")]]);

    const tracks = await fetchRoam(new NeteaseClient("MUSIC_U=abc"), 2);

    expect(tracks.map((track) => track.id)).toEqual(["1", "2"]);
    expect(calls).toHaveLength(1);
  });

  it("某轮没有新歌就提前退出", async () => {
    const calls = stubRadio([[song("1")], [song("1")], [song("2")]]);

    const tracks = await fetchRoam(new NeteaseClient("MUSIC_U=abc"), 100);

    // 第二轮全是重复，直接停；第三轮的 "2" 不该被问到。
    expect(tracks.map((track) => track.id)).toEqual(["1"]);
    expect(calls).toHaveLength(2);
  });

  it("上游回空数组时只问一轮", async () => {
    const calls = stubRadio([[]]);

    expect(await fetchRoam(new NeteaseClient("MUSIC_U=abc"), 100)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
