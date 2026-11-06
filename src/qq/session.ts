/**
 * QQ 音乐 App 扫码的 MQTT 会话池。
 *
 * 扫码事件是**推到这条 MQTT 连接上**的：每轮状态轮询都重新建连，会在确认
 * 登录时漏掉 `cookies` 推送（面板就会永远停在「已扫码」）。所以连接必须在
 * Durable Object 的内存里跨请求保留，直到登录成功或二维码过期。
 *
 * Durable Object 只要还有打开的 WebSocket 就不会被回收；这里的 TTL 只是兜底，
 * 防止用户关掉页面后连接一直挂着。
 */

import { MobileQRSocket } from "./mqtt";

interface Entry {
  socket: MobileQRSocket;
  timer: ReturnType<typeof setTimeout>;
}

export class MobileLoginSessions {
  private readonly entries = new Map<string, Entry>();

  /** 取出某个二维码的连接；不存在或已断开时新建一条。 */
  get(qrcodeID: string, ttlMs: number): MobileQRSocket {
    const existing = this.entries.get(qrcodeID);
    if (existing && !existing.socket.isClosed) {
      return existing.socket;
    }
    if (existing) {
      this.close(qrcodeID);
    }

    const socket = new MobileQRSocket(qrcodeID);
    const timer = setTimeout(() => this.close(qrcodeID), ttlMs);
    this.entries.set(qrcodeID, { socket, timer });
    return socket;
  }

  close(qrcodeID: string): void {
    const entry = this.entries.get(qrcodeID);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    entry.socket.close();
    this.entries.delete(qrcodeID);
  }

  /** 开始新的二维码时调用：旧二维码无论如何都不能再登录了。 */
  closeAll(): void {
    for (const key of [...this.entries.keys()]) {
      this.close(key);
    }
  }
}
