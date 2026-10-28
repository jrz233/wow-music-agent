import { describe, expect, it } from "vitest";
import { hash33, parsePtuiCB } from "../src/qq/client";
import { mapPlaylist as mapQQPlaylist, mapTrack as mapQQTrack } from "../src/qq/api";
import { mapPlaylist as mapNeteasePlaylist, mapTrack as mapNeteaseTrack } from "../src/netease/api";
import { cookiesForHost, mergeCookies, parseCookies } from "../src/shared/http";

describe("QQ login helpers", () => {
  it("computes hash33 like ptlogin", () => {
    expect(hash33("")).toBe(0);
    expect(hash33("a")).toBe(97);
    expect(hash33("abc")).toBe(108966);
  });

  it("parses ptuiCB and decodes the nickname", () => {
    const parsed = parsePtuiCB(
      "ptuiCB('0','0','https://graph.qq.com/oauth2.0/login_jump?a=1&amp;b=2','0','登录成功','%E5%B0%8F%E6%98%8E')",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe("0");
    expect(parsed?.url).toBe("https://graph.qq.com/oauth2.0/login_jump?a=1&b=2");
    expect(parsed?.nickname).toBe("小明");
  });

  it("returns null for unrelated bodies", () => {
    expect(parsePtuiCB("<html>maintenance</html>")).toBeNull();
  });
});

describe("cookie handling", () => {
  it("merges Set-Cookie without duplicates", () => {
    const response = new Response(null, {
      headers: [
        ["set-cookie", "a=1; Path=/; HttpOnly"],
        ["set-cookie", "b=2; Path=/"],
      ],
    });
    const merged = mergeCookies("a=0; c=3", response);
    const jar = parseCookies(merged);
    expect(jar.get("a")).toBe("1");
    expect(jar.get("b")).toBe("2");
    expect(jar.get("c")).toBe("3");
  });

  it("空值不覆盖已有的非空值", () => {
    // QQ 登录链会用 `p_skey=; Max-Age=0` 清旧值，随后才下发真值；反过来也可能。
    // 空值把刚拿到的 p_skey 抹掉，就是「扫码成功但没拿到 p_skey」。
    const response = new Response(null, {
      headers: [["set-cookie", "p_skey=; Max-Age=0; Path=/"]],
    });
    expect(parseCookies(mergeCookies("p_skey=REAL", response)).get("p_skey")).toBe("REAL");
  });

  it("只挑浏览器会带去目标主机的 Cookie（Domain 匹配）", () => {
    const lines = [
      "uin=o123; Path=/; Domain=.qq.com",
      "skey=abc; Domain=qq.com; Path=/",
      "host_only=1; Path=/",
      "other=2; Domain=.example.com",
      "empty=; Domain=.qq.com",
    ];
    const cookies = cookiesForHost(lines, "ssl.ptlogin2.graph.qq.com");
    expect([...cookies.keys()].sort()).toEqual(["skey", "uin"]);
    expect(cookiesForHost(lines, "example.com").get("other")).toBe("2");
  });
});

describe("QQ mapping", () => {
  it("自建歌单用 tid 而不是 dirId 作为详情 id", () => {
    // 「我喜欢」的 dirId 固定是 201，但 srfDissInfo 只认 tid；用 201 会回
    // -100006。参考 wow-origin 的 user_playlist_created：id = tid。
    const playlist = mapQQPlaylist({
      dirId: 201,
      dirName: "我喜欢",
      tid: 5461570933,
      songNum: 142,
    });
    expect(playlist.id).toBe("5461570933");
    expect(playlist.name).toBe("我喜欢");
    expect(playlist.trackCount).toBe(142);
  });

  it("maps a list item and a wrapped track_info", () => {
    const playlist = mapQQPlaylist({
      dissid: 123,
      diss_name: "夜跑",
      dirPicUrl: "https://y.qq.com/pic.jpg",
      song_cnt: 8,
      tag: ["流行"],
      create_time: 1_700_000_000,
    });
    expect(playlist).toMatchObject({
      id: "123",
      name: "夜跑",
      trackCount: 8,
      tags: ["流行"],
      createdAt: 1_700_000_000,
    });

    const track = mapQQTrack({
      track_info: {
        mid: "0039MnYb0qxYhV",
        name: "晴天",
        interval: 269,
        index_album: 3,
        singer: [{ mid: "0025NhlN2yWrP4", name: "周杰伦" }],
        album: { mid: "000MkMni19ClKG", name: "叶惠美" },
      },
    });
    expect(track.id).toBe("0039MnYb0qxYhV");
    expect(track.title).toBe("晴天");
    expect(track.durationMs).toBe(269_000);
    expect(track.artists[0]).toEqual({ id: "0025NhlN2yWrP4", name: "周杰伦" });
    expect(track.album.id).toBe("000MkMni19ClKG");
    expect(track.album.coverUrl).toContain("000MkMni19ClKG");
    expect(track.trackNumber).toBe(3);
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(mapQQTrack({ track_info: "oops" })).toMatchObject({ id: "", title: "" });
    expect(mapQQPlaylist(null).id).toBe("");
  });
});

describe("netease mapping", () => {
  it("maps playlists and tracks", () => {
    const playlist = mapNeteasePlaylist({
      id: 42,
      name: "我喜欢的音乐",
      coverImgUrl: "https://p1.music.126.net/a.jpg",
      trackCount: 12,
      createTime: 1_600_000_000_000,
      tags: ["流行"],
    });
    expect(playlist).toMatchObject({ id: "42", trackCount: 12, createdAt: 1_600_000_000 });

    const track = mapNeteaseTrack({
      id: 99,
      name: "稻香",
      ar: [{ id: 1, name: "周杰伦" }],
      al: { id: 2, name: "魔杰座", picUrl: "https://p1.music.126.net/b.jpg" },
      dt: 223_000,
      no: 2,
      cd: "1",
      alia: ["Rice Field"],
      fee: 1,
    });
    expect(track).toMatchObject({
      id: "99",
      title: "稻香",
      durationMs: 223_000,
      trackNumber: 2,
      discNumber: 1,
      aliases: ["Rice Field"],
      fee: true,
    });
    expect(track.album.coverUrl).toContain("b.jpg");
  });

  it("does not leak arbitrary input fields", () => {
    const track = mapNeteaseTrack({ id: 1, name: "x", cookie: "MUSIC_U=secret", url: "https://evil" });
    expect(JSON.stringify(track)).not.toContain("MUSIC_U");
    expect(JSON.stringify(track)).not.toContain("evil");
  });
});
