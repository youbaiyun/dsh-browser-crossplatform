// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { BridgeClient, type BridgeState } from '../src/background/bridge.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    // 真 bridge 总是用一份 policy 回答 `hello`，所以这个假的
    // 也照做；省略它的 fixture 会被帧解析器拒掉，连接
    // 就永远静默地认证不完。
    const delivered = isRecord(frame) && frame.t === 'hello.ok' && frame.policy === undefined
      ? { ...frame, policy: { openPagesForUser: true } }
      : frame
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(delivered) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient address recovery', () => {
  const sinks = { onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} }

  it('re-resolves the address once the current one looks permanently gone', async () => {
    // 桌面应用启动时挑端口，所以一次重启可能落在
    // 别处。没有这段逻辑，重试循环会一直探那个已死的端口，
    // 而 keepalive 在状态是 `reconnecting` 时不肯插手。
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const probe = vi.fn(async (url: string) => url.includes(':3081'))
    const rediscover = vi.fn(async () => 'ws://127.0.0.1:3081/ext/bridge')
    const client = new BridgeClient(sinks, probe, () => true, rediscover)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(rediscover).toHaveBeenCalled()
    // 迁移后的地址才是真正被拨打的地址。
    expect(probe).toHaveBeenCalledWith('ws://127.0.0.1:3081/ext/bridge')
    expect(FakeWebSocket.instances.at(-1)?.url).toBe('ws://127.0.0.1:3081/ext/bridge')
    client.stop()
  })

  it('asks only once per threshold while the address has not moved', async () => {
    // 只是挂掉的 bridge 绝不能变成发现循环：
    // 否则每次重试都会去猛敲六个端口。
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const rediscover = vi.fn(async () => 'ws://127.0.0.1:3080/ext/bridge')
    const client = new BridgeClient(sinks, async () => false, () => true, rediscover)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    // 两次失败：没到阈值，所以发现流程根本没跑过。
    await vi.advanceTimersByTimeAsync(600)
    expect(rediscover).not.toHaveBeenCalled()

    // 过了阈值，发现流程会跑——但没变化的答复不会
    // 被当成迁移，所以退避会继续涨，不会重置。
    await vi.advanceTimersByTimeAsync(3_000)
    expect(rediscover.mock.calls.length).toBeLessThanOrEqual(2)
    client.stop()
  })

  it('leaves a manually entered address alone', async () => {
    // 后台只给自动发现的地址提供回调；
    // 这里钉住的是：手动输入的地址绝不能被悄悄替换。
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const probe = vi.fn(async (_url: string) => false)
    const client = new BridgeClient(sinks, probe, () => true, undefined)

    client.start('ws://127.0.0.1:9/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(5_000)

    const probed = probe.mock.calls.map((call) => call[0])
    expect(probed.length).toBeGreaterThan(0)
    expect(probed.every((url) => url === 'ws://127.0.0.1:9/ext/bridge')).toBe(true)
    client.stop()
  })
})

describe('BridgeClient connection probe', () => {
  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    socket.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('records a rejection so the panel can name the fix, and clears it once connected', async () => {
    // 4002 / 1008 是"服务器明确拒绝了这次握手"：装错构建、扩展 id 不在白名单、或令牌不对。
    // 这和"桌面端没开"在面板上原本长得一模一样，而只有这一类是用户自己能修的。
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await vi.advanceTimersByTimeAsync(0)

    socket.close(4002, 'bad token')
    await vi.advanceTimersByTimeAsync(0)
    expect(client.lastRejection).toEqual({ code: 4002, reason: 'bad token' })

    // 重连成功后这条记录必须消失，否则面板会一直摆着一条已经过时的警告。
    await vi.advanceTimersByTimeAsync(30_000)
    const next = FakeWebSocket.instances.at(-1)!
    next.open()
    await vi.advanceTimersByTimeAsync(0)
    next.receive({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')
    expect(client.lastRejection).toBeNull()
  })

  it('stops reconnecting after its user-owned lease disappears', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => active)

    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    active = false
    socket.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
