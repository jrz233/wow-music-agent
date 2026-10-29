/**
 * 两端共享的语义化形状。
 *
 * 这些**不是** wow-server SDK 的 Track/Playlist：Agent 只返回平台原始语义，
 * wow-server 负责补 `qq:`/`wy:` 前缀、`fromLabel` 与白名单裁剪。任何字段都可能
 * 被 wow-server 丢弃，因此这里绝不能放令牌、Cookie、播放地址或平台隐私字段。
 */

export type Platform = "qq" | "netease";

export const PLATFORMS: readonly Platform[] = ["qq", "netease"];

export interface AgentTrack {
  id: string;
  title: string;
  artists: { id: string; name: string }[];
  album: { id: string; name: string; coverUrl: string };
  durationMs: number;
  discNumber?: number;
  trackNumber?: number;
  aliases?: string[];
  fee?: boolean;
}

export interface AgentPlaylist {
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  trackCount: number;
  playCount: number;
  tags: string[];
  createdAt: number | null;
  updatedAt: number | null;
}

export interface AgentPlaylistDetail extends AgentPlaylist {
  tracks: AgentTrack[];
}

export interface ListPage<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number;
}

export interface PlatformStatus {
  loggedIn: boolean;
  nickname: string;
  userId: string;
  avatarUrl: string;
  lastRefreshAt: number;
  expiresAt: number;
}

export interface AgentStatus {
  apiVersion: number;
  agentVersion: string;
  /** 可选能力列表；服务端据此启用依赖新接口的功能（如 `library.snapshot`）。 */
  capabilities?: string[];
  platforms: { qq: PlatformStatus; netease: PlatformStatus };
}

export interface PlatformAccount {
  userId: string;
  nickname: string;
  avatarUrl: string;
  /** 平台自己的会话材料（Cookie 等），只存在于 DO 内，且加密落库。 */
  credential: string;
  /** 平台会话到期时间；0 表示未知（按刷新周期探活）。 */
  expiresAt: number;
}

export interface PlaylistRef {
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  trackCount: number;
  playCount: number;
  tags: string[];
}

export interface TrackPage {
  items: AgentTrack[];
  hasMore: boolean;
  total: number;
}

export interface PlaylistPage {
  items: AgentPlaylist[];
  hasMore: boolean;
  nextOffset: number;
}
