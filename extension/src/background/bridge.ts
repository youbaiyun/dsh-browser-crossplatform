/**
 * bridge WebSocket 客户端（background 侧）：连上 dsh bridge，用 bearer token 认证，
 * 靠指数退避重连把连接维持住，并回应协议层的 ping。
 *
 * 重连策略跟 dsh GUI 自己的 ConnectionController 一致：基准 500ms，每次尝试 ×2，
 * 上限 10s，抖动 0.5–1×。
 *
 * @module
 */

import type { BridgeCaps, BridgePolicy, ClientFrame, ServerFrame } from '@dsh-browser/protocol'
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  isServerFrame,
  parseBridgeFrame,
} from '@dsh-browser/protocol'

/** 给 UI 用的粗粒度连接状态。 */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/** background 装配层持有的帧/状态 sink。 */
export interface BridgeSinks {
  onStateChange(state: BridgeState): void
  onFrame(frame: ServerFrame): void
  onHelloOk(caps: BridgeCaps, policy: BridgePolicy): void
}

/** 预判打开一个 WebSocket 会不会成功。 */
type BridgeProbe = (url: string) => Promise<boolean>

/**
 * 当前 URL 没动静之后，重新解析 bridge URL。
 *
 * 桌面应用是启动时才挑端口的，所以重启一次可能落到别处。光靠重试循环恢复不了：
 * 它会永远探同一个 URL，而 keepalive 又刻意跳过处于 `reconnecting` 的客户端。
 * 返回同一个字符串表示"什么都没变"，循环接着退避。
 */
type BridgeDiscovery = () => Promise<string | undefined>

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
const HELLO_ACK_TIMEOUT_MS = 5_000

/**
 * 连续探测失败几次之后才去要新 URL。
 *
 * 三次失败大约是 1.5s 的退避：长到正常重启（端口还会回来）永远碰不到它，
 * 又短到端口搬走之后不用手动重载面板就能被发现。
 */
const REDISCOVER_AFTER_FAILURES = 3

/** 管着一个 WebSocket 连接世代和它的重连循环。 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private running = false
  /** 每次 start 的世代令牌：新的 start() 会让还在跑的循环失效。 */
  private generation = 0
  private url = ''
  private token = ''
  private ackTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * bridge 把这个客户端踢出去、把唯一的槽位交给另一个浏览器时置位（close code 4000）。
   * 之后重试循环必须安静下来：两个都重连的开着的 profile 会永远互相踢。
   * 只有显式的 start() 才抢得回这个槽位。
   */
  private replaced = false
  /** 连续探测失败了几次；成功一次就清零。 */
  private probeFailures = 0

  constructor(
    readonly sinks: BridgeSinks,
    private readonly probe: BridgeProbe = async () => true,
    /** 断开的客户端是不是还攥着一个活跃的、属于用户的租约。 */
    private readonly shouldReconnect: () => boolean = () => true,
    /**
     * 当前 URL 看着像永久消失之后，重新解析 bridge URL。默认表示"地址从不变化"，
     * 对手动输入的地址来说这是对的。
     */
    private readonly rediscover: BridgeDiscovery | undefined = undefined,
  ) {}

  /** 当前粗粒度状态（和最近一次发出去的 sink 值一致）。 */
  state: BridgeState = 'stopped'

  /**
   * 最近一次**被 bridge 拒绝**的关闭码与理由，连上之后清空。
   *
   * 为什么需要它：401 之外的失败里，只有这一种是用户能自己修的，而面板原本只会显示
   * 「未连接」。装了 `-store` 包手动加载、或者换了扩展 id 之后，服务器以 4002
   * `bad token` 关闭——用户看到的现象和"dsh 没开"一模一样，无从判断。
   */
  lastRejection: { code: number; reason: string } | null = null

  /**
   * 连上（或重连）bridge。幂等：拿同样的 url/token 再调一次，循环会从 attempt 0 重开。
   * @param url - bridge 的 WebSocket URL（比如 ws://127.0.0.1:3080/ext/bridge）。
   * @param token - 设置里那个 bearer token。
   */
  start(url: string, token: string): void {
    this.stop()
    this.url = url
    this.token = token
    this.running = true
    this.attempt = 0
    this.replaced = false
    this.lastRejection = null
    this.generation += 1
    void this.loop(this.generation)
  }

  /** 停掉循环，关掉当前 socket。 */
  stop(): void {
    this.running = false
    this.clearAckTimer()
    this.ws?.close()
    this.ws = null
    this.emitState('stopped')
  }

  /**
   * UI 租约一没，就放弃正在进行的重连，同时为那些用户已经启用的后台审批留一条
   * 已认证的 socket。之后 socket 再掉，仍会去问 shouldReconnect()。
   *
   * 目前刻意哪儿都不调它，也留着它没删。它当初为之而写的那个调用方，是本扩展并不
   * 拥有的 UI 租约：控制条是个侧边面板，它的生命周期属于浏览器，不属于某个文档；
   * 而唯一能当租约用的状态——设置里的 `enabled`——本来就会直接把客户端停掉。
   * 把它接到一个根本不是租约的东西上，会让那些只是关掉弹窗的用户被断连，
   * 所以这个没人用的钩子是两者里更安全的那个。
   */
  suspendReconnect(): void {
    if (this.state === 'connected') return
    this.stop()
  }

  /** 现在能不能发帧。 */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * 这个客户端是不是已经把槽位让给了另一个浏览器。
   *
   * 扩展的 keepalive 读它，而不是从 `state` 猜：被顶替同样收场于 `stopped`，
   * 但在那种状态下重启它，会把刚拿到连接的浏览器踢掉。
   */
  get wasReplaced(): boolean {
    return this.replaced
  }

  /**
   * 发一个客户端帧。
   * @param frame - 要发的帧。
   * @returns 没有活着的 socket 时返回 false。
   */
  send(frame: ClientFrame): boolean {
    const socket = this.ws
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  /**
   * 请 background 重新解析 bridge 地址。
   * @returns 地址真的变了、目标已经搬走时返回 true。
   */
  private async resolveMovedUrl(): Promise<boolean> {
    if (this.rediscover === undefined) return false
    const found = await this.rediscover().catch(() => undefined)
    if (found === undefined || found === '' || found === this.url) return false
    this.url = found
    return true
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      if (!this.retryAllowed()) return
      // 被顶替的客户端绝不会自己再拨号；retryAllowed() 已经把 `running` 摘掉了，
      // 所以这里只是写给读者看这次交接。
      if (this.replaced) return
      const reachable = await this.probe(this.url).catch(() => false)
      if (!this.running || generation !== this.generation) return
      if (!this.retryAllowed()) return
      if (!reachable) {
        this.emitState('reconnecting')
        this.probeFailures += 1
        if (this.probeFailures >= REDISCOVER_AFTER_FAILURES) {
          // 地址可能跟着桌面应用一起搬走了。每到一个阈值只问一次，
          // 这样一个还宕着的 bridge 不会每次重试都被探一遍。
          this.probeFailures = 0
          const moved = await this.resolveMovedUrl()
          if (!this.running || generation !== this.generation) return
          if (!this.retryAllowed()) return
          // 地址搬走就是换了个新目标，退避得从头开始，
          // 而不是继承对那个已死目标攒下来的延迟。
          if (moved) { this.attempt = 0; continue }
        }
        await this.waitBeforeRetry()
        continue
      }
      this.probeFailures = 0

      const socket = new WebSocket(this.url)
      this.ws = socket
      // 被顶替是所有权交接，不是一次短暂的传输失败。就此永久让出，
      // 两个开着的 profile 才不会在死循环里反复互相踢。
      socket.addEventListener('close', (event) => {
        // 记下"是服务器拒绝了这次握手"这一类关闭码：4002（令牌/扩展 id 不匹配）与
        // 1008（策略违规）。它们和"连不上"看起来一样，但对用户的意义完全不同——
        // 前者说明装的东西不对，后者说明桌面端没起来。
        if (this.ws === socket && (event.code === 4002 || event.code === 1008)) {
          this.lastRejection = { code: event.code, reason: event.reason }
        }
        if (event.code !== 4000 || this.ws !== socket || !this.running) return
        this.running = false
        this.replaced = true
        this.clearAckTimer()
        this.ws = null
        this.emitState('stopped')
      }, { once: true })
      this.emitState('connecting')

      await new Promise<void>((resolve) => {
        socket.addEventListener('open', () => { resolve() }, { once: true })
        socket.addEventListener('close', () => { resolve() }, { once: true })
        socket.addEventListener('error', () => { resolve() }, { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        await this.fail(socket)
        continue
      }

      // 认证：hello 被接受之前，不能有任何别的流量。
      socket.send(JSON.stringify({
        t: 'hello',
        token: this.token,
        caps: { textOnly: true, snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS, maxInteractiveItems: 60 },
      } satisfies ClientFrame))

      let authed = false
      const accepted = await new Promise<boolean>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          const frame = parseBridgeFrame(String(event.data))
          if (frame === undefined) return
          if (!authed) {
            if (frame.t === 'hello.ok') {
              authed = true
              this.clearAckTimer()
              resolve(true)
              this.sinks.onHelloOk(frame.caps, frame.policy)
            } else if (frame.t === 'error' || frame.t === 'rpc.result' || frame.t === 'event') {
              this.sinks.onFrame(frame)
            }
            return
          }
          if (frame.t === 'ping') {
            socket.send(JSON.stringify({ t: 'pong' } satisfies ClientFrame))
            return
          }
          if (isServerFrame(frame)) this.sinks.onFrame(frame)
        }
        socket.addEventListener('message', onMessage)
        socket.addEventListener('close', () => {
          this.clearAckTimer()
          resolve(false)
        }, { once: true })
        this.ackTimer = setTimeout(() => resolve(false), HELLO_ACK_TIMEOUT_MS)
      })
      if (!accepted || !this.running || generation !== this.generation) {
        await this.fail(socket)
        continue
      }

      this.attempt = 0
      // 连上了就把上一次的拒绝原因清掉：它属于那次失败，不该继续挂在面板上。
      this.lastRejection = null
      this.emitState('connected')

      await new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true })
        socket.addEventListener('error', () => resolve(), { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      await this.fail(socket)
    }
  }

  private async fail(socket: WebSocket): Promise<void> {
    if (this.ws === socket) this.ws = null
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
    if (!this.running) return
    if (!this.retryAllowed()) return
    this.emitState('reconnecting')
    await this.waitBeforeRetry()
  }

  private retryAllowed(): boolean {
    if (this.shouldReconnect()) return true
    this.running = false
    this.emitState('stopped')
    return false
  }

  private async waitBeforeRetry(): Promise<void> {
    this.attempt += 1
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempt - 1))
    const delay = cap / 2 + Math.random() * (cap / 2)
    await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer)
      this.ackTimer = undefined
    }
  }

  private emitState(state: BridgeState): void {
    this.state = state
    this.sinks.onStateChange(state)
  }
}
