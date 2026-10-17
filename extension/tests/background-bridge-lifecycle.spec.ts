// @vitest-environment jsdom

/**
 * 浏览器跑 worker 的生命周期与面板协议测试。
 *
 * bridge 不租给任何人：worker 在设置加载完就
 * 连上，因为安装扩展本身就是那个选择。
 * `dsh-control` 端口只是一个看状态、答决策的面板。
 * 这些测试用一个伪造的 `chrome.*` 和一个伪造的
 * WebSocket 启动真实 worker，断言的是这套契约，而不是旧的面板租约契约。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import type { ApprovalRequest } from '../src/security/approval.ts'
import { CONTROL_PORT_NAME, type ControlState } from '../src/settings.ts'

/** worker 在 `hello` 里给出的 caps；bridge 会把协商好的 caps 回显回来。 */
const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
const KEEPALIVE_ALARM = 'dsh-bridge-keepalive'
const BRIDGE_URL = 'wss://bridge.example/ext/bridge'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value))
  }

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

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of [...listeners]) listener(...args) },
  }
}

function htmlTab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId: 1,
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
  }
}

/** 一个面板端口：有名字，能应答。 */
function controlPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = {
    name: CONTROL_PORT_NAME,
    postMessage,
    onMessage,
    onDisconnect,
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

type MessageSpy = ReturnType<typeof vi.fn>

/** worker 推给面板的一条消息，带上待测字段。 */
interface ControlMessageLike {
  type?: string
  state?: ControlState
  request?: ApprovalRequest
  entry?: { id?: string; name?: string; state?: string }
  id?: string
  ok?: boolean
  error?: string
}

function sentMessages(postMessage: MessageSpy): ControlMessageLike[] {
  return postMessage.mock.calls.map((call) => call[0] as ControlMessageLike)
}

function latestState(postMessage: MessageSpy): ControlState | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'state').at(-1)?.state
}

function approvalRequest(postMessage: MessageSpy): ApprovalRequest | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'approval.request').at(-1)?.request
}

/**
 * 打开伪造的 socket，等到 worker 的 `hello` 发出来。
 *
 * 客户端在发 `hello` 的同一轮里挂上自己的帧监听器，
 * 所以这一轮还 pending 时推进来的帧会没有
 * 任何人接。
 */
async function openBridge(socket: FakeWebSocket): Promise<void> {
  socket.open()
  await vi.waitFor(() => {
    expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' }))
  })
}

function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  tabGet?: (tabId: number) => Promise<chrome.tabs.Tab>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  tabRemove?: (tabId: number) => Promise<void>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  executeScript?: () => Promise<unknown>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const onNotificationClicked = chromeEvent<[string]>()
  const onNotificationButtonClicked = chromeEvent<[string]>()
  const onInstalled = chromeEvent<[{ reason: string }]>()
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm,
  }
  const action = {
    setBadgeText: vi.fn(async () => {}),
    setBadgeBackgroundColor: vi.fn(async () => {}),
    // 工具栏图标没有 popup；侧边面板由浏览器打开。
    onClicked: chromeEvent<[chrome.tabs.Tab]>(),
  }
  const sidePanel = {
    open: vi.fn(async () => {}),
    setPanelBehavior: vi.fn(async () => {}),
  }
  const notifications = {
    create: vi.fn(async () => ''),
    clear: vi.fn(async () => true),
    onClicked: onNotificationClicked,
    onButtonClicked: onNotificationButtonClicked,
  }
  const tabs = {
    get: vi.fn(options.tabGet ?? (async (tabId: number) => htmlTab(tabId))),
    query: vi.fn(options.tabQuery ?? (async () => [htmlTab(1)])),
    remove: vi.fn(options.tabRemove ?? (async () => {})),
    create: vi.fn(async () => htmlTab(1)),
    sendMessage: vi.fn(options.tabSendMessage ?? (async () => {})),
    reload: vi.fn(async () => {}),
    onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
    onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
    onReplaced: chromeEvent<[number, number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  const windows = {
    WINDOW_ID_NONE: -1,
    getLastFocused: vi.fn(async () => ({ id: 1 })),
    onFocusChanged: chromeEvent<[number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  vi.stubGlobal('chrome', {
    action,
    alarms,
    notifications,
    sidePanel,
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
      onInstalled,
    },
    storage: {
      local: {
        get: vi.fn(options.localGet ?? (async () => ({}))),
        set: vi.fn(options.localSet ?? (async () => {})),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs,
    webNavigation: {
      getAllFrames: vi.fn(async () => []),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: {
      executeScript: vi.fn(options.executeScript ?? (async () => [])),
    },
    windows,
  } as unknown as typeof chrome)
  return { action, alarms, notifications, onConnect, onInstalled, sidePanel, tabs, windows }
}

/**
 * worker 模块最后加载的那份副本。
 *
 * 排队中的一次发现重试会让模块图活着并在之后触发，
 * 所以拆除必须取消测试用的同一个实例。在
 * afterEach 里用普通的 `import()` 会加载一份新副本、启动新的定时器。
 */
let loadedWorker: { cancelPendingWork?: () => void } | undefined

afterEach(() => {
  loadedWorker?.cancelPendingWork?.()
  loadedWorker = undefined
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background bridge lifecycle', () => {
  it('connects from boot without any panel and reports caps to one that opens later', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')

    // 从没连过任何端口：bridge 不是这次连接启动的。
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toBe('ws://127.0.0.1:3080/ext/bridge')
    expect(chromeMock.alarms.create).toHaveBeenCalledWith(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
    expect(chromeMock.alarms.clear).not.toHaveBeenCalled()
    // 侧边面板是浏览器自己开的，不是 action handler 开的。
    expect(chromeMock.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true })

    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    // 一连上就立刻用当前视图状态作答。
    expect(sentMessages(control.postMessage)[0]).toMatchObject({ type: 'state' })
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)).toMatchObject({
        enabled: true,
        bridge: 'connected',
        caps: { snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
      })
    })
  })

  it('always connects, because installing the extension is the choice', async () => {
    // 没有 autoConnect 这个设置：一个得被告知去连接的面板是
    // 一种支持负担，而遗留的存储值绝不能把它关掉。
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { autoConnect: false } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // 遗留的 `autoConnect: false` 绝不能阻止扩展连接，所以
    // 发现流程必须在这里成功，下面的 socket 才可能冒出来。
    // 答案必须是 `ws://` URL：bridge-config 回复会被校验，
    // 而安全协议的 URL 会被当成不可用跳过，不会被拨打。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 })))

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(chromeMock.alarms.create).toHaveBeenCalledWith(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })

    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)).toMatchObject({ enabled: true, bridge: 'connecting' })
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('re-pushes state on state.request', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    control.postMessage.mockClear()

    control.onMessage.emit({ type: 'state.request' })
    await vi.waitFor(() => {
      expect(sentMessages(control.postMessage)[0]).toMatchObject({ type: 'state' })
    })
  })

  it('authenticates with the stored token and publishes each connection state to an open panel', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, token: 'secret-token' } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connecting') })

    socket.open()
    await vi.waitFor(() => {
      expect(socket.sent[0]).toEqual({ t: 'hello', token: 'secret-token', caps: HELLO_CAPS })
    })
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
  })

  it('retries bridge discovery from the keepalive alarm when nothing answered at boot', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(6) })
    expect(FakeWebSocket.instances).toHaveLength(0)

    chromeMock.alarms.onAlarm.emit({ name: KEEPALIVE_ALARM, scheduledTime: Date.now() })
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(12) })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('panel protocol', () => {
  it('acknowledges a settings save only after persistence and keeps the bridge for a policy change', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    /** worker 尝试过的每一次设置保存，按顺序排。 */
    const savedSettings: Record<string, unknown>[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }),
      // 只挂起这次设置写入。worker 的诊断探测
      // 会把自己的键写进同一个存储，把那个也卡住就会堵死
      // 这个测试正要观察的队列。
      localSet: async (items) => {
        if (!('dshSettings' in items)) return
        savedSettings.push(items.dshSettings as Record<string, unknown>)
        await settingsWrite
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    control.onMessage.emit({
      type: 'settings.update',
      id: 'policy-1',
      settings: { unrestrictedBrowserAccess: true },
    })
    // 统计的是设置保存次数，不是对存储的每次调用：
    // worker 还会写一条诊断记录，那不算一次设置保存。
    await vi.waitFor(() => { expect(savedSettings).toHaveLength(1) })
    expect(sentMessages(control.postMessage)).not.toContainEqual(expect.objectContaining({
      type: 'settings.result',
      id: 'policy-1',
    }))

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'policy-1', ok: true })
    })
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: true }),
    })
    // policy 变化不是连接变化：活跃的 socket 保持不变。
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('keeps the live socket across a layout preference change', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({ type: 'settings.update', id: 'layout-1', settings: { fixedWidth: false } })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'layout-1', ok: true })
    })
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(latestState(control.postMessage)).toMatchObject({ enabled: true, bridge: 'connected' })
    expect(chromeMock.alarms.clear).not.toHaveBeenCalled()
  })

  it('reconnects to a newly entered bridge address', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const original = FakeWebSocket.instances[0]!
    await openBridge(original)
    original.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({
      type: 'settings.update',
      id: 'url-1',
      settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' },
    })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(FakeWebSocket.instances[1]!.url).toBe('wss://replacement.example/ext/bridge')
    expect(original.readyState).toBe(FakeWebSocket.CLOSED)
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'url-1', ok: true })
    })
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      dshSettings: expect.objectContaining({ bridgeUrl: 'wss://replacement.example/ext/bridge' }),
    })
  })

  it('reports a settings persistence failure back to the panel that asked', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }),
      // 这次要测的失败是设置保存。让诊断
      // 探测的写入也一起失败会普遍搞坏设置持久化，
      // 把启动行为拖进一个关于保存处理的测试里。
      localSet: async (items) => {
        if ('dshSettings' in items) throw new Error('Storage is unavailable')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // 什么都没配置，所以启动会走发现流程。一次发现调用就能拿到
    // 这个测试要的 socket；一次拒绝会让面板完全没有 bridge，
    // 把一个保存处理测试变成发现流程测试。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 })))

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    const socketsBefore = FakeWebSocket.instances.length
    control.onMessage.emit({
      type: 'settings.update',
      id: 'failed-1',
      settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' },
    })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'failed-1',
        ok: false,
        error: 'Storage is unavailable',
      })
    })
    // 那次失败的保存从没到过连接层：它想设置的
    // 地址没有被拨打，活跃的 socket 也没受影响。
    expect(FakeWebSocket.instances).toHaveLength(socketsBefore)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('offers a pending approval to the panel and applies its decision to the tool call', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: false } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    socket.receive({
      t: 'tool.call',
      id: 'close-1',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    const request = await vi.waitFor(() => {
      const pending = approvalRequest(control.postMessage)
      expect(pending?.id).toBeTypeOf('string')
      return pending!
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
    expect(sentMessages(control.postMessage)).toContainEqual(expect.objectContaining({
      type: 'activity',
      entry: expect.objectContaining({ id: 'close-1', state: 'running' }),
    }))

    // 之后才打开的面板照样能看到每个还没结算的决定。
    control.onMessage.emit({ type: 'state.request' })
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)?.approvals.map((entry) => entry.id)).toContain(request.id)
    })

    control.onMessage.emit({ type: 'approval.respond', id: request.id, decision: 'allow-once' })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'close-1', ok: true }))
    })
    await vi.waitFor(() => {
      expect(sentMessages(control.postMessage)).toContainEqual(expect.objectContaining({
        type: 'activity',
        entry: expect.objectContaining({ id: 'close-1', state: 'done' }),
      }))
    })
    expect(latestState(control.postMessage)?.approvals.map((entry) => entry.id)).not.toContain(request.id)
  })

  it('opens the panel itself when the model starts using the browser', async () => {
    // 用户想看着事情发生——它在找什么、在
    // 下载什么——所以一次浏览器工具调用会把面板带到前台。
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    // 打开面板的不是面板自己：这里没有连任何端口。
    expect(chromeMock.sidePanel.open).not.toHaveBeenCalled()

    socket.receive({
      t: 'tool.call',
      id: 'snap-1',
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalledOnce() })
    // 它认的是用户面前的那个窗口，而不是 Chrome
    // 碰巧认为当前的那个窗口。
    expect(chromeMock.sidePanel.open).toHaveBeenCalledWith({ windowId: 1 })
  })

  it('leaves the panel alone while a plain conversation runs', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    // prompt 是一次对话，不是浏览器动作。把它推到
    // worker 真发出自己的 RPC，再断言什么都没打开。
    socket.receive({
      t: 'event',
      frame: { rpcId: 'rpc-1', method: 'session/create', payload: {} },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chromeMock.sidePanel.open).not.toHaveBeenCalled()
    expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' }))
  })

  it('opens the panel once for a burst of browser work, not once per call', async () => {
    // 一个连跑十次调用的模型，不该跟用户抢十次。
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const call = (id: string) => socket.receive({
      t: 'tool.call',
      id,
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    call('snap-1')
    call('snap-2')
    call('snap-3')
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-3' }))
    })

    expect(chromeMock.sidePanel.open).toHaveBeenCalledOnce()
  })

  it('opens the panel again once the cooldown has passed', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const call = (id: string) => socket.receive({
      t: 'tool.call',
      id,
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })

    call('snap-1')
    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalledOnce() })

    // 后面的一轮是新的事情要看，面板会再被带到前台一次。
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(Date.now() + 61_000)
    call('snap-2')
    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalledTimes(2) })
    vi.useRealTimers()
  })

  it('honours autoOpenPanel being switched off', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, autoOpenPanel: false } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    socket.receive({
      t: 'tool.call',
      id: 'snap-1',
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    // 让这次调用收尾，断言才不会和它抢跑。
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-1' }))
    })
    expect(chromeMock.sidePanel.open).not.toHaveBeenCalled()
  })

  it('promotes "don\'t ask again" into the stored tab-switch setting', async () => {    // 每个开关的提示以前一重启 worker 就忘了自己的答案，
    // 于是用户永远被问同一件事。用
    // 「保留，别再问」回答，就必须写进设置。
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, tabSwitch: 'ask' } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.tabs.query).toHaveBeenCalled() })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({ type: 'affinity.rebind', id: 'bind-1' })
    await vi.waitFor(() => {
      expect(latestState(control.postMessage)?.affinity).toMatchObject({ controlled: { tabId: 1 } })
    })

    // 用户切走了，这在默认的 `ask` 模式下会弹提示。
    chromeMock.tabs.onActivated.emit({ tabId: 2, windowId: 1 })
    const handoff = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('handoff')
      return state
    })

    control.onMessage.emit({
      type: 'affinity.respond',
      revision: handoff.affinity.revision,
      decision: 'keep-always',
    })
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.affinity.status).toBe('background') })

    // 存下来的是那个偏好，不只是 pin。
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      dshSettings: expect.objectContaining({ tabSwitch: 'keep' }),
    })
    // 而且这正是面板现在看到的，于是显示同一个答案。
    expect(latestState(control.postMessage)?.settings.tabSwitch).toBe('keep')
  })

  it('raises a system notification when an approval arrives with no panel open', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: false } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    socket.receive({
      t: 'tool.call',
      id: 'close-1',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(chromeMock.notifications.create).toHaveBeenCalledWith(
        expect.stringMatching(/^dsh-approval:/),
        expect.objectContaining({ requireInteraction: true }),
      )
    })
    // 失败关闭：没有面板作答，所以什么都还跑不了。
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('applies an affinity keep/follow choice and rejects a stale revision', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, tabSwitch: 'ask' } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chromeMock.tabs.query).toHaveBeenCalled() })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)

    control.onMessage.emit({ type: 'affinity.rebind', id: 'bind-1' })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'affinity.rebind.result', id: 'bind-1', ok: true })
    })
    expect(latestState(control.postMessage)?.affinity).toMatchObject({
      status: 'following',
      controlled: { tabId: 1 },
    })

    // 用户切标签页会让工具派发暂停，直到面板做出选择。
    chromeMock.tabs.onActivated.emit({ tabId: 2, windowId: 1 })
    const handoff = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('handoff')
      // 占位的切换项会被标签页的真实元数据替换。
      expect(state.affinity.active?.url).toBe('https://example.com/2')
      return state
    })
    expect(handoff.affinity.controlled).toMatchObject({ tabId: 1 })

    control.onMessage.emit({ type: 'affinity.respond', revision: handoff.affinity.revision, decision: 'keep' })
    const kept = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('background')
      return state
    })
    expect(kept.affinity.controlled).toMatchObject({ tabId: 1 })

    chromeMock.tabs.onActivated.emit({ tabId: 3, windowId: 1 })
    const secondHandoff = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('handoff')
      expect(state.affinity.active?.url).toBe('https://example.com/3')
      return state
    })
    control.onMessage.emit({
      type: 'affinity.respond',
      revision: secondHandoff.affinity.revision,
      decision: 'follow',
    })
    const followed = await vi.waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.affinity.status).toBe('following')
      return state
    })
    expect(followed.affinity.controlled).toMatchObject({ tabId: 3 })

    // 对一个用户已经解决过的开关做决定，不会改变任何东西。
    const messageCount = sentMessages(control.postMessage).length
    control.onMessage.emit({ type: 'affinity.respond', revision: handoff.affinity.revision, decision: 'keep' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(sentMessages(control.postMessage)).toHaveLength(messageCount)
    expect(latestState(control.postMessage)?.affinity).toMatchObject({
      status: 'following',
      controlled: { tabId: 3 },
    })
  })
})

/**
 * 首次运行引导。
 *
 * 刚装好的扩展没被固定到工具栏，也没法自己
 * 固定，所以从文件安装的用户看不到任何东西出现。那条
 * 通知是他们和「永远找不到它」之间唯一的东西——
 * 而这正是那种会悄悄坏掉的功能，因为维护它的人
 * 早就装好了扩展，再也不会看到它。
 */
describe('first-run guidance', () => {
  it('offers the toolbar hint on a fresh install', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    chromeMock.onInstalled.emit({ reason: 'install' })

    await vi.waitFor(() => {
      expect(chromeMock.notifications.create).toHaveBeenCalledWith(
        'dsh-onboarding',
        expect.objectContaining({ requireInteraction: true }),
      )
    })
    // 这条消息必须说清楚图标去哪了，否则只是噪声。
    const calls = chromeMock.notifications.create.mock.calls as unknown as [string, { message: string }][]
    expect(calls.at(-1)?.[1].message).toMatch(/toolbar|拼图/i)
  })

  it('stays quiet on an update, so an existing user is not told twice', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    chromeMock.onInstalled.emit({ reason: 'update' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(chromeMock.notifications.create).not.toHaveBeenCalled()
  })

  it('opens the panel when the hint is clicked, since that click is the required gesture', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)

    loadedWorker = await import('../src/background/index.ts')
    chromeMock.notifications.onClicked.emit('dsh-onboarding')

    await vi.waitFor(() => { expect(chromeMock.sidePanel.open).toHaveBeenCalled() })
    expect(chromeMock.notifications.clear).toHaveBeenCalledWith('dsh-onboarding')
  })
})
