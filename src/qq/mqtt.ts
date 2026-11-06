/**
 * 最小 MQTT 5 客户端，只覆盖 QQ 音乐 App 扫码登录。
 *
 * App 扫码跟手机 QQ 的 ptlogin 是两条完全不同的链路：二维码由
 * `music.login.LoginServer/CreateQRCode` 下发，但扫码 / 确认的结果不走
 * `CheckQRCode`（它只会回 40000/40001/40002，永远拿不到凭据），而是由 App
 * 通过 MQTT 5 over WebSocket 推送到 `management.qrcode_login/{qrcodeID}`。
 *
 * 协议细节对齐 Android 客户端（参考 kunyin-desktop / HotDownloader 的实现）：
 *
 *   - 握手必须带子协议 `mqtt`，不带会被服务端用 reason 0x9d + server_reference
 *     打发到另一个节点；
 *   - CONNECT 的 properties 带 authMethod=pass 和 tmeAppID/business/hashTag/
 *     clientTag/userID 五个 user property；
 *   - SUBSCRIBE 的 user property 是 authorization=tmelogin、pubsub=unicast；
 *   - PUBLISH 的 `type` 依次是 scanned → cookies / canceled / timeout /
 *     loginFailed。`cookies` 的 payload 里才有换票用的 musicid 与 token。
 *
 * 这里只实现扫码用得到的报文（CONNECT / SUBSCRIBE 构造，CONNACK / SUBACK /
 * PUBLISH 解析），不追求通用性。
 */

const CONNECT = 0x10;
const CONNACK = 0x20;
const PUBLISH = 0x30;
const PUBACK = 0x40;
const SUBSCRIBE = 0x82;
const SUBACK = 0x90;
const PINGREQ = 0xc0;
const DISCONNECT = 0xe0;

const AUTH_METHOD = 0x15;
const USER_PROPERTY = 0x26;
const SERVER_REFERENCE = 0x1c;
const REASON_STRING = 0x1f;

const WS_URL = "wss://mu.y.qq.com/ws/handshake";
/** 服务端最多重定向几次；超过就放弃，避免握手风暴。 */
const REDIRECT_LIMIT = 3;
/**
 * Keep Alive 报的是 45 秒，但服务端大约 1.5 个周期（~67 秒）才判定超时。
 * 20 秒一次 PINGREQ 留足余量：一旦被断开，确认后的 `cookies` 推送就漏了。
 */
const PING_INTERVAL_MS = 20_000;

type UserProperty = [string, string];

/** MQTT 报文的变长整数（Variable Byte Integer）。 */
class ByteWriter {
  private readonly bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u16(value: number): void {
    this.bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  raw(value: Uint8Array): void {
    for (const byte of value) {
      this.bytes.push(byte);
    }
  }

  varInt(value: number): void {
    let rest = value;
    do {
      let byte = rest % 128;
      rest = Math.floor(rest / 128);
      if (rest > 0) {
        byte |= 0x80;
      }
      this.bytes.push(byte);
    } while (rest > 0);
  }

  toArray(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function buildProperties(authMethod: string | null, userProperties: UserProperty[]): Uint8Array {
  const writer = new ByteWriter();
  if (authMethod !== null) {
    const value = utf8(authMethod);
    writer.u8(AUTH_METHOD);
    writer.u16(value.length);
    writer.raw(value);
  }
  for (const [key, value] of userProperties) {
    const keyBytes = utf8(key);
    const valueBytes = utf8(value);
    writer.u8(USER_PROPERTY);
    writer.u16(keyBytes.length);
    writer.raw(keyBytes);
    writer.u16(valueBytes.length);
    writer.raw(valueBytes);
  }
  return writer.toArray();
}

export function buildConnectPacket(clientId: string, qrcodeID: string): Uint8Array {
  const payload = new ByteWriter();
  payload.u16(4);
  payload.raw(utf8("MQTT"));
  payload.u8(5); // MQTT 5.0
  payload.u8(0x02); // Clean Start
  payload.u16(45); // Keep Alive 秒

  const properties = buildProperties("pass", [
    ["tmeAppID", "qqmusic"],
    ["business", "management"],
    ["hashTag", qrcodeID],
    ["clientTag", "management.user"],
    ["userID", qrcodeID],
  ]);
  payload.varInt(properties.length);
  payload.raw(properties);

  const client = utf8(clientId);
  payload.u16(client.length);
  payload.raw(client);

  return frame(CONNECT, payload);
}

export function buildSubscribePacket(packetId: number, qrcodeID: string): Uint8Array {
  const payload = new ByteWriter();
  payload.u16(packetId);

  const properties = buildProperties(null, [
    ["authorization", "tmelogin"],
    ["pubsub", "unicast"],
  ]);
  payload.varInt(properties.length);
  payload.raw(properties);

  const topic = utf8(`management.qrcode_login/${qrcodeID}`);
  payload.u16(topic.length);
  payload.raw(topic);
  payload.u8(0); // QoS 0

  return frame(SUBSCRIBE, payload);
}

function frame(type: number, body: ByteWriter | Uint8Array): Uint8Array {
  const bytes = body instanceof ByteWriter ? body.toArray() : body;
  const writer = new ByteWriter();
  writer.u8(type);
  writer.varInt(bytes.length);
  writer.raw(bytes);
  return writer.toArray();
}

/** QoS 1 的 PUBLISH 必须回 PUBACK，否则服务端会重发同一条推送。 */
export function buildPubackPacket(packetId: number): Uint8Array {
  return new Uint8Array([PUBACK, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]);
}

export function buildPingreqPacket(): Uint8Array {
  return new Uint8Array([PINGREQ, 0x00]);
}

class ByteReader {
  private position = 0;

  constructor(private readonly buffer: Uint8Array) {}

  get remaining(): number {
    return this.buffer.length - this.position;
  }

  get offset(): number {
    return this.position;
  }

  u8(): number {
    return this.buffer[this.position++] ?? 0;
  }

  u16(): number {
    const value = ((this.buffer[this.position] ?? 0) << 8) | (this.buffer[this.position + 1] ?? 0);
    this.position += 2;
    return value;
  }

  read(length: number): Uint8Array {
    const slice = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  varInt(): number {
    let value = 0;
    let multiplier = 1;
    let byte: number;
    do {
      byte = this.u8();
      value += (byte & 0x7f) * multiplier;
      multiplier *= 128;
    } while ((byte & 0x80) !== 0);
    return value;
  }

  utf8String(): string {
    return decoder.decode(this.read(this.u16()));
  }
}

export interface MqttPacket {
  type: number;
  qos?: number;
  packetId?: number;
  reasonCode?: number;
  serverReference?: string;
  userProperties: Record<string, string>;
  payload?: Uint8Array;
}

export function parsePacket(data: Uint8Array): MqttPacket | null {
  if (data.length === 0) {
    return null;
  }
  const reader = new ByteReader(data);
  const header = reader.u8();
  const type = header & 0xf0;
  const qos = (header >> 1) & 0x03;
  reader.varInt(); // Remaining Length，按帧读即可，不依赖它切包

  switch (type) {
    case CONNACK:
      return parseConnack(reader);
    case SUBACK:
      return parseSuback(reader);
    case PUBLISH:
      return parsePublish(reader, qos);
    default:
      return { type, userProperties: {} };
  }
}

function parseConnack(reader: ByteReader): MqttPacket {
  reader.u8(); // Acknowledge Flags
  const reasonCode = reader.u8();
  if (reader.remaining <= 0) {
    return { type: CONNACK, userProperties: {} };
  }

  const end = reader.offset + reader.varInt();
  let serverReference: string | undefined;
  while (reader.offset < end && reader.remaining > 0) {
    const id = reader.u8();
    if (id === SERVER_REFERENCE) {
      serverReference = reader.utf8String();
    } else if (id === REASON_STRING) {
      reader.utf8String();
    } else if (id === USER_PROPERTY) {
      reader.utf8String();
      reader.utf8String();
    } else {
      break;
    }
  }

  // 0x9c = Use Another Server、0x9d = Server Moved：都带着 server_reference
  // 重连，其余交给超时。只认 0x9d 时，0x9c 会被当成成功，然后卡在等 SUBACK。
  if ((reasonCode === 0x9c || reasonCode === 0x9d) && serverReference !== undefined) {
    return { type: CONNACK, serverReference, userProperties: {} };
  }
  return { type: CONNACK, userProperties: {} };
}

function parseSuback(reader: ByteReader): MqttPacket {
  reader.u16(); // Packet Identifier
  const end = reader.offset + reader.varInt();
  while (reader.offset < end && reader.remaining > 0) {
    reader.u8(); // 订阅属性；这里用不到
  }
  // 每个 filter 一个 reason code，>= 0x80 表示订阅被拒。
  const reasonCode = reader.remaining > 0 ? reader.u8() : 0;
  return { type: SUBACK, reasonCode, userProperties: {} };
}

function parsePublish(reader: ByteReader, qos: number): MqttPacket {  reader.utf8String(); // topic
  // QoS > 0 的报文在 topic 之后先有 Packet Identifier，再是属性。
  const packetId = qos > 0 ? reader.u16() : undefined;

  const end = reader.offset + reader.varInt();
  const userProperties: Record<string, string> = {};
  while (reader.offset < end && reader.remaining > 0) {
    const id = reader.u8();
    if (id === USER_PROPERTY) {
      const key = reader.utf8String();
      userProperties[key] = reader.utf8String();
    } else {
      break;
    }
  }

  return { type: PUBLISH, qos, packetId, userProperties, payload: reader.read(reader.remaining) };
}

/** 扫码过程中面板关心的状态。 */
export type MobileQREvent =
  | { kind: "scanned" }
  | { kind: "cookies"; uin: string; key: string }
  | { kind: "canceled" }
  | { kind: "timeout" }
  | { kind: "failed" }
  | { kind: "closed"; reason: string };

/**
 * 一次长轮询内的 MQTT 会话：连上、订阅、等一个事件。
 *
 * 调用方拿到事件后就把连接关掉；下一次轮询会重新建连。二维码会话本身由
 * `qrcodeID` 标识，重连不会丢会话，只有建连空档里的推送会漏掉（很短）。
 */
export class MobileQRSocket {
  private readonly clientId = `${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
  private socket: WebSocket | null = null;
  private closed = false;
  private waiting: {
    resolve: (event: MobileQREvent | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly queue: MobileQREvent[] = [];
  /**
   * 换票状态。服务端会反复推 `cookies`，而同一个二维码的 token 只能换一次票；
   * 两个面板标签页同时轮询时也会各收到一条。这里只让第一条推送触发换票，
   * 换票失败后才允许重试。
   */
  private loginState: "idle" | "running" | "done" = "idle";
  /** 换票卡住（请求被浏览器取消等）时兜底回到 idle，别让连接再也接不了推送。 */
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keep Alive 心跳；不 ping 的话服务端约 67 秒后主动断连。 */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly qrcodeID: string) {
    this.connect("");
  }

  /**
   * 等下一个事件；超时返回 null（调用方按「等待扫码」处理）。
   *
   * 超时**不**关闭连接：扫码事件是推到这条连接上的，重连会丢掉确认后的
   * `cookies` 推送。连接由 `MobileLoginSessions` 在整个二维码会话期间保留。
   */
  wait(timeoutMs: number): Promise<MobileQREvent | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    if (this.waiting) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting?.timer !== timer) {
          return;
        }
        this.waiting = null;
        resolve(null);
      }, timeoutMs);
      this.waiting = { resolve, timer };
    });
  }

  /** 连接是否已断开（被对端关闭或主动关闭）。 */
  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.waiting = null;
    this.clearLoginTimer();
    this.clearPingTimer();
    try {
      this.socket?.close(1000, "done");
    } catch {
      // 连接可能已经关了，忽略。
    }
  }

  private connect(path: string, redirects = 0): void {
    const socket = new WebSocket(`${WS_URL}${path}`, ["mqtt"]);
    // 不设置的话 Workers 默认投递 Blob，解析 MQTT 报文会失败。
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.closed || this.socket !== socket) {
        return;
      }
      socket.send(buildConnectPacket(this.clientId, this.qrcodeID));
    });

    socket.addEventListener("message", (event) => {
      if (this.closed || this.socket !== socket) {
        return;
      }
      const data = toBytes(event.data);
      if (!data) {
        return;
      }
      const packet = parsePacket(data);
      if (!packet) {
        return;
      }

      if (packet.serverReference !== undefined) {
        if (redirects >= REDIRECT_LIMIT) {
          this.emit({ kind: "closed", reason: "redirect loop" });
          return;
        }
        this.socket = null;
        this.clearPingTimer();
        try {
          socket.close(1000, "redirect");
        } catch {
          // 忽略。
        }
        this.connect(`/${packet.serverReference}`, redirects + 1);
        return;
      }

      if (packet.type === CONNACK) {
        socket.send(buildSubscribePacket(1, this.qrcodeID));
        return;
      }

      if (packet.type === SUBACK) {
        if ((packet.reasonCode ?? 0) >= 0x80) {
          console.warn("qq mobile mqtt subscribe rejected", { reasonCode: packet.reasonCode });
          this.emit({ kind: "closed", reason: "subscribe rejected" });
          return;
        }
        // 订阅成功后开始心跳：等待确认可能长达几分钟，中间不能掉线。
        this.startPing(socket);
        return;
      }

      if (packet.type === PUBLISH) {
        this.handlePublish(packet);
        return;
      }

      if (packet.type === DISCONNECT) {
        // 服务端主动断开（报文里的 reason code 不解析，交给重连即可）。
        this.socket = null;
        this.closed = true;
        this.clearPingTimer();
        try {
          socket.close(1000, "server disconnect");
        } catch {
          // 忽略。
        }
        this.emit({ kind: "closed", reason: "server disconnect" });
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.closed) {
        return;
      }
      this.socket = null;
      this.closed = true;
      this.clearPingTimer();
      this.emit({ kind: "closed", reason: "connection closed" });
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket || this.closed) {
        return;
      }
      // close 事件随后会到，这里只记一笔，让日志里能看到握手失败。
      console.warn("qq mobile mqtt error", { qrcodeID: this.qrcodeID });
    });
  }

  private handlePublish(packet: MqttPacket): void {
    // QoS 1 要回 PUBACK；不回的话服务端会一直重发同一条推送。
    if (packet.qos === 1 && packet.packetId !== undefined) {
      try {
        this.socket?.send(buildPubackPacket(packet.packetId));
      } catch {
        // 连接已经断了，close 事件会走重连。
      }
    }
    const type = packet.userProperties.type ?? "";
    // 只打事件类型：payload 里是登录凭据，不能进日志。
    if (type !== "") {
      console.log("qq mobile mqtt event", { type });
    }
    if (type === "scanned") {
      this.emit({ kind: "scanned" });
      return;
    }
    if (type === "canceled") {
      this.emit({ kind: "canceled" });
      return;
    }
    if (type === "timeout") {
      this.emit({ kind: "timeout" });
      return;
    }
    if (type === "loginFailed") {
      this.emit({ kind: "failed" });
      return;
    }
    if (type !== "cookies" || !packet.payload) {
      return;
    }

    const values = cookieValues(packet.payload);
    if (!values) {
      this.emit({ kind: "failed" });
      return;
    }
    // 同一张二维码只换一次票：重复推送（或两个标签页同时轮询）不能重复调用
    // Login，否则后一次会拿着已经用掉的 token 换票失败。
    if (this.loginState !== "idle") {
      return;
    }
    this.loginState = "running";
    this.loginTimer = setTimeout(() => {
      if (this.loginState === "running") {
        this.loginState = "idle";
      }
    }, 30_000);
    // 只打账号长度与数值性：微信账号的 musicid 有 19 位，超长说明必须按原样
    // 数字换票；token 本身不进日志。
    console.log("qq mobile cookies", {
      uinLength: values.uin.length,
      uinNumeric: /^[1-9]\d*$/u.test(values.uin),
    });
    this.emit({ kind: "cookies", uin: values.uin, key: values.key });
  }

  /** 换票成功：这条连接不再接受重复的 `cookies` 推送。 */
  loginSucceeded(): void {
    this.loginState = "done";
    this.clearLoginTimer();
  }

  /** 换票失败：允许后续推送重试。 */
  loginFailed(): void {
    if (this.loginState === "running") {
      this.loginState = "idle";
    }
    this.clearLoginTimer();
  }

  private clearLoginTimer(): void {
    if (this.loginTimer !== null) {
      clearTimeout(this.loginTimer);
      this.loginTimer = null;
    }
  }

  private startPing(socket: WebSocket): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.closed || this.socket !== socket) {
        return;
      }
      try {
        socket.send(buildPingreqPacket());
      } catch {
        // close 事件随后会到。
      }
    }, PING_INTERVAL_MS);
    // Node 测试进程里别让心跳拖住退出；Workers 的定时器没有这个方法。
    (this.pingTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private emit(event: MobileQREvent): void {
    if (this.waiting) {
      const pending = this.waiting;
      this.waiting = null;
      clearTimeout(pending.timer);
      pending.resolve(event);
      return;
    }
    this.queue.push(event);
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/** `cookies` 事件里同时兼容 `{value}` 包装和裸字符串两种形状。 */
function cookieValues(payload: Uint8Array): { uin: string; key: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  const cookies = (parsed as { cookies?: Record<string, unknown> } | null)?.cookies;
  if (!cookies) {
    return null;
  }
  const uin = unwrapCookie(cookies.qqmusic_uin);
  const key = unwrapCookie(cookies.qqmusic_key);
  if (!uin || !key) {
    return null;
  }
  return { uin, key };
}

function unwrapCookie(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") {
      return inner;
    }
    if (typeof inner === "number" && Number.isFinite(inner)) {
      return String(inner);
    }
  }
  return "";
}
