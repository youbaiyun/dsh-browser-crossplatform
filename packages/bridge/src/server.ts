/**
 * bridge 的 WebSocket 承载层：带 token 认证的连接注册表、gateway RPC 派发、每连接的
 * 事件泵，以及向已连接的浏览器扩展派发工具调用。
 *
 * 本服务挂的路由（`/ext/bridge`）在 /api 信任围栏之外（那道围栏只管 client-connection
 * 的路由），所以 bridge 自带认证：`hello` 帧里出示 bearer token，且要在
 * HELLO_TIMEOUT_MS 之内到达。Host 调用终结在 bridge 自有的 Host 适配器上。被 /api
 * 承载层钉在 loopback 上的那些方法（`PRIVILEGED_METHODS`）在这里同样只允许 loopback，
 * 跟 token 无关——这是给 `--host 0.0.0.0` 部署留的纵深防御。
 *
 * 同一时刻只有一条活跃连接：新的已认证 socket 会顶掉上一个（旧 socket 被关掉，它还在
 * 途中的工具调用以 `bridge-closed` 结束）。
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { BrowserHostApi } from './host-api.ts'
import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_SESSION_PURGE_METHOD,
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseBridgeFrame,
  type BridgeFrame,
  type BridgeCaps,
  type BridgePolicy,
  type ClientFrame,
  type ToolErrorCode,
} from '@dsh-browser/protocol'
import { SessionPurgeError } from './session-purge.ts'
import type { ImageRelay } from './image-relay.ts'
import { verifyToken } from './token.ts'

/**
 * 被 /api 承载层钉在 loopback 上的 gateway 方法（镜像 client-connection 的
 * PRIVILEGED_METHODS，原样保留，两道围栏才不会各自漂移）。就算 token 有效，bridge 对
 * 非 loopback 的远端也照样拒绝这些方法。
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/** 到达顺序会显著影响行为的那些 session 变更。 */
const ORDERED_SESSION_METHODS = new Set([
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  'session.prompt',
  'session.cancel',
])

/** loopback 的 IPv4/IPv6 字面量（含 IPv4 映射形式）。导出它是为了测试和复用。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 构造那个唯一能在 loopback 上跳过 token 的 Origin 值。 */
export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`
}

/**
 * 一次升级的 `Origin` 是不是*本*扩展。
 *
 * 光看 scheme 不算身份：每个 Chrome 扩展出示的都是某种 `chrome-extension://` origin，
 * 只匹配前缀的话，任何另一个已安装的扩展——或者一个只是设了这个头的本地进程——都能不带
 * token 够到 bridge。id 必须逐个点名，而且每一个都精确比较。
 *
 * 允许配置多个 id，是因为同一个构建可能有多个。未打包的开发加载被 manifest 的 `key`
 * 钉死，而 Chrome 应用商店会拒收带那个 key 的 manifest、自己分配一个 id——所以同一份
 * 源码出示其中任意一个 origin 都是正当的。
 *
 * @param origin - 升级请求的 `Origin` 头（如果有）。
 * @param extensionId - 逗号分隔的已配置 id；为空就禁掉这条绕过。
 *   首尾空白和空条目都忽略，所以末尾多一个逗号没事，不会变成一个悄悄没配置好的
 *   bridge。
 * @returns 只有和某个点名的 id 精确匹配时才为 true。
 */
export function isTrustedExtensionOrigin(origin: string | undefined, extensionId: string | undefined): boolean {
  // 直接调构造函数可能压根不填这个字段（schema 默认值只在插件路径上生效），
  // 所以只要不是非空字符串，就表示“没有配置 id”，
  // 而不是“拿去跟 undefined 比”。
  if (typeof origin !== 'string' || typeof extensionId !== 'string' || extensionId === '') return false
  return extensionId
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
    .some((id) => origin === extensionOrigin(id))
}

/** requestTool 抛出的错误；工具注册表会把它变成 isError 结果。 */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** bridge 需要宿主提供的依赖。 */
export interface BridgeServerDeps {
  /** 扩展必须在 `hello` 中出示的 bearer token。 */
  token: string
  /**
   * 允许在 loopback 升级时跳过 bearer token 的那一个 Chrome 扩展 id。为空（直接构造
   * server 时则是没给）表示没有任何 origin 能跳过 token，这是未配置 bridge 的安全
   * 默认值。
   */
  extensionId?: string
  /** 当前的 dsh Host 适配器，unary 调用、事件和 waterfall 都走它。 */
  api: BrowserHostApi
  /** 单次工具调用的默认超时，单位毫秒。 */
  toolTimeoutMs: number
  /** 要在 `hello.ok` 中回显的能力（协商后的快照预算）。 */
  caps: BridgeCaps
  /** 桌面端允许哪些行为，随能力一起放在 `hello.ok` 里发过去。 */
  policy: BridgePolicy
  /**
   * 替扩展做图片识别。没配置视觉模型时缺省，扩展会从 `hello.ok` 的 policy 里知道
   * 这一点。
   */
  imageRelay?: ImageRelay
  /**
   * 为什么没有可用的中继，说得让用户能据此行动。
   *
   * 在 `hello.ok` 里发过去，扩展就能把它摆到那个要求识别图片的人面前，而不是只报
   * “识别不可用”——那会让读者卡在死胡同里，没有下一步。
   */
  visionUnavailableReason?: string
  /** 把一份被跟随页面的快照注入活跃或延迟创建的 Agent session。 */
  injectBrowserSnapshot: (sessionId: string, snapshot: string) => void | Promise<void>
  /**
   * 永久删掉某个 session 的持久化存储。调用方会先通过 gateway 归档该 session，这里只
   * 负责删文件。
   */
  purgeSession: (sessionId: string) => Promise<void>
  /**
   * 测试接缝：强制指定权限闸门看到的远端地址。沙箱里绑不了任意的 loopback 字面量，
   * 所以非 loopback 分支靠这个 override 覆盖；生产环境从不设置它。
   */
  remoteAddressOverride?: string
  /** 新 socket 多久之内要出示 `hello`；默认 HELLO_TIMEOUT_MS。 */
  helloTimeoutMs?: number
  /** 服务端 ping 的节奏；默认 PING_INTERVAL_MS。 */
  pingIntervalMs?: number
}

/** 一次在途的工具调用，正在等待扩展的 `tool.result`。 */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
}

/** 一个已通过认证、并占据那唯一活跃槽位的 socket。 */
interface ReadyConnection {
  ws: WebSocket
  /** 升级时捕获的远端地址（特权方法的 loopback 闸门）。 */
  remoteAddress: string | undefined
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
}

function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  /* v8 ignore next -- 拆除期竞态：socket 可能在某个 pump 的就绪检查
  与这次写入之间死掉；这个守卫拒绝对已死的 socket 写入 */
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * 把一条 ws 消息载荷解成文本。之所以导出，是为了让三种投递形态（分片的 buffer 数组、
 * Buffer、ArrayBuffer）都能直接单元测试——实际用起来 node ws 只会投递 Buffer。
 * @param data - ws 消息载荷。
 * @returns 解码后的 UTF-8 文本。
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * 带 token 认证的 bridge 服务端。每个插件实例构造一次，用 {@link close} 收尾。
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private current: ReadyConnection | null = null
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * 处理 bridge 路径上的一次 HTTP 升级。
   * @param req - 升级请求（带着客户端的远端地址）。
   * @param socket - HTTP 服务端移交过来的原始 socket。
   * @param head - 升级头之后已经读到的字节。
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    const origin = req.headers.origin
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote, origin) })
  }

  /**
   * 向已连接的扩展要一次浏览器动作。
   * @param name - 工具名（同时也是 wire 动作名）。
   * @param args - 已校验的工具参数。
   * @param signal - 调用方的取消信号（abort 会让这次调用以“已取消”结束）。
   * @param timeoutMs - 单次调用的预算；默认取插件配置里的值。
   * @param sessionId - 可选的、拥有这次调用的 Agent session，用来保持审批的连续性。
   * @returns 扩展的动作结果。
   * @throws 没有扩展连接、调用超时、被取消，或扩展报错时抛 BridgeToolError。
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
    }
    // 已经 abort 的调用方绝不能派发：下面的 abort 监听器不会为预先 abort 的信号重放，
    // 那样这次调用还是会被发给扩展并执行掉，
    // 尽管它已经被取消。
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // 调用方不再等待之后，扩展可能还停在等用户批准上。在本地结清之前先撤回那份
        // 批准，这样一个迟到的点击
        // 就执行不了一个已经过期的动作。
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        // 调用方停止等待属于超时，不是连接不存在：在这里报 `bridge-closed` 会让
        // “扩展一直没回答”和“从来就没有连接”
        // 变得分不出来，而这个区别恰恰是诊断
        // “浏览器连着但闲着”所需要的。
        cancel(new BridgeToolError('timeout', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer })
      conn.ws.send(JSON.stringify({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame), (error) => {
        /* v8 ignore next -- 拆除期竞态：写入失败时，socket 的 close 处理器
        会用同一个错误码结算同一次调用；这条 callback 路径是防御性的第二次结算，
        经由 close 路径覆盖 */
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * 关掉服务端：关闭 acceptor、丢掉所有 socket、拒掉所有在途的工具调用。
   * @returns 等 acceptor 和所有 pump 都停下来之后才 resolve 的 promise。
   */
  async close(): Promise<void> {
    // 幂等：第二次 close 绝不能碰 acceptor（关一个已经关掉的服务端时，
    // ws 会抛 "The server is not running"）。
    if (this.closed) return
    this.closed = true
    // 趁 replaceConnection 还没把连接置空，先抓住活着的那个 pump。
    const pumps = this.current === null ? [] : [this.current.pump]
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        /* v8 ignore next -- acceptor 的关闭不可能失败：close() 是幂等的，
        而 noServer acceptor 只会报告已经终止的客户端的拆除 */
        if (error === undefined) resolve()
        /* v8 ignore next -- 同一条不可达分支 */
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns 当前是否有已认证的扩展连接着。 */
  hasConnection(): boolean {
    return this.current !== null
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined, origin: string | undefined): void {
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        ws.close(1008, 'unparseable frame')
        return
      }
      if (helloTimer !== undefined) {
        // 待握手状态：只有 `hello` 是合法的。
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        // 零配置本地模式：来自*本*扩展的 loopback 升级跳过 token，
        // 这样扩展能自己发现 bridge，用户什么都不用粘。
        // WebSocket 没有同源策略，任何页面或本地进程都能顶着 loopback 远端
        // 访问 127.0.0.1——所以这条捷径绑在已配置的扩展 id 上，
        // 而且要和确切的 Origin 比对。`chrome-extension://` 前缀**不是**
        // 身份：每个 Chrome 扩展都有一个。
        // Firefox 的 moz-extension:// origin 带的是每次安装都不同的 UUID，
        // 不是 manifest 里那个稳定的 Gecko ID，所以它构不成身份边界，
        // 必须出示 bearer token。
        // 非 loopback 的远端也一样。
        const loopbackNoToken = isLoopbackAddress(remoteAddress)
          && isTrustedExtensionOrigin(origin, this.deps.extensionId)
        if (!loopbackNoToken && !verifyToken(this.deps.token, frame.token)) {
          ws.close(4002, 'bad token')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        this.promote(ws, remoteAddress)
        return
      }
      this.handleReadyFrame(frame)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** 把一个已认证的 socket 提升为那唯一的活跃槽位。 */
  private promote(ws: WebSocket, remoteAddress: string | undefined): void {
    this.replaceConnection()
    const abort = new AbortController()
    const ping = setInterval(() => { sendFrame(ws, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const frame of this.deps.api.events(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          sendFrame(ws, {
            t: 'event',
            frame,
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendFrame(ws, { t: 'error', code: 'stream-failed', message: String(error) })
          // 一个已认证、却没有 Remote 流的 socket 没法用，
          // 可在扩展看来其它方面都正常。关掉这一代连接
          // 会激活它有界的重连循环，并重建每个 follower。
          ws.close(1011, 'event stream failed')
        }
      }
    })()
    this.current = { ws, remoteAddress, abort, pump, ping }
    // 中继在不在是这个标志的唯一依据，
    // 这样插件就宣传不了一个它没接上的能力。
    sendFrame(ws, {
      t: 'hello.ok',
      caps: this.deps.caps,
      policy: {
        ...this.deps.policy,
        imageRecognition: this.deps.imageRelay?.available === true,
        // 随帧带过去，而不是记日志：用户只有这一条途径知道该修什么，
        // 而他们会在扩展里读到它。
        ...this.deps.imageRelay?.available === true || this.deps.visionUnavailableReason === undefined
          ? {}
          : { imageRecognitionHint: this.deps.visionUnavailableReason },
      },
    })
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
  }

  private handleReadyFrame(frame: BridgeFrame): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame)
        break
      case 'respond':
        void this.handleRespond(frame)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
        break
      case 'image.call':
        void this.handleImageCall(frame)
        break
      case 'pong':
      case 'hello':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'error':
        // 协议违规的、以及服务端主动发来的形态都忽略；
        // 这条通道上只有扩展会发东西。
        break
    }
  }

  /** 在途的识别请求；扩展那边也会限制自己的并发。 */
  private imageCallsInFlight = 0
  private readonly maxImageCalls = 4

  /**
   * 处理扩展发来的一次图片识别请求。
   *
   * 失败用一个帧应答回去，而不是抛异常，因为扩展要把它记进 manifest：模型必须知道
   * “这里有一张图，但读不出来”，而不是什么都看不到。
   */
  private async handleImageCall(frame: Extract<ClientFrame, { t: 'image.call' }>): Promise<void> {
    const ws = this.current?.ws
    if (ws === undefined) return
    const relay = this.deps.imageRelay
    if (relay === undefined) {
      sendFrame(ws, {
        t: 'image.result',
        id: frame.id,
        ok: false,
        error: { code: 'no-vision', message: 'image recognition is not configured on the desktop' },
      })
      return
    }
    if (this.imageCallsInFlight >= this.maxImageCalls) {
      sendFrame(ws, {
        t: 'image.result',
        id: frame.id,
        ok: false,
        error: { code: 'busy', message: 'too many recognition requests in flight' },
      })
      return
    }

    this.imageCallsInFlight += 1
    try {
      const result = await relay.recognize(frame.request, frame.source)
      if (ws.readyState !== WebSocket.OPEN) return
      sendFrame(ws, result.ok
        ? { t: 'image.result', id: frame.id, ok: true, desc: result.desc }
        : { t: 'image.result', id: frame.id, ok: false, error: { code: result.code, message: result.message } })
    } finally {
      this.imageCallsInFlight -= 1
    }
  }

  /**
   * 按 session 保住 prompt/cancel 的到达顺序。尤其是第一条 prompt 可能还在创建临时
   * session；在那次接纳完成之前，它的 cancel 绝不能到 gateway。
   */
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame)
      return
    }
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame),
      () => this.handleRpc(frame),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- 顶替竞态：一帧可能落在 socket 被顶替和下一次提升之间；
    这次复查让该处理器保持全定义 */
    if (conn === null) return
    const forbidden = PRIVILEGED_METHODS.has(frame.method) && !isLoopbackAddress(conn.remoteAddress)
    if (forbidden) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'method is loopback-only' } })
      return
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId and snapshot must be non-empty strings' },
        })
        return
      }
      try {
        await this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      }
      return
    }
    if (frame.method === BRIDGE_SESSION_PURGE_METHOD) {
      const sessionId = purgeSessionPayload(frame.payload)
      if (sessionId === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId must be a non-empty string' },
        })
        return
      }
      try {
        await this.deps.purgeSession(sessionId)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { purged: true } })
      } catch (error: unknown) {
        const code = error instanceof SessionPurgeError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code, message } })
      }
      return
    }
    try {
      const result = await this.deps.api.call({
        rpcId: frame.id,
        method: frame.method,
        payload: frame.payload,
        signal: conn.abort.signal,
      })
      sendFrame(conn.ws, {
        t: 'rpc.result',
        id: frame.id,
        ok: true,
        result: { type: 'server-response', rpcId: frame.id, result },
      })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  /** 把待处理的 Host waterfall 响应经当前适配器中继出去。 */
  private async handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- 顶替竞态；已关闭的 socket 只是把回执丢掉 */
    if (conn === null) return
    try {
      const result = await this.deps.api.respond(frame.rpcId, frame.result, conn.abort.signal)
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  private settleTool(id: string, ok: boolean, payload: unknown): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
  }

  /** 关掉当前连接（如果有），并结清它还在途中的调用。 */
  private replaceConnection(): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was replaced'))
    }
  }
}

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  return { sessionId, snapshot }
}

function purgeSessionPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  return sessionId
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * 工具错误载荷 → 稳定的错误码。wire 解析器会强制 string 字段，所以这些回退分支由
 * 解析器把关；导出它是为了让回退契约能直接单元测试。
 * @param payload - 扩展上报的错误载荷。
 * @returns 稳定的错误码。
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * 工具错误载荷 → 消息。wire 解析器会强制 string 字段，所以这些回退分支由解析器把关；
 * 导出它是为了让回退契约能直接单元测试。
 * @param payload - 扩展上报的错误载荷。
 * @returns 人能读的消息。
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'browser action failed'
  }
  return 'browser action failed'
}
