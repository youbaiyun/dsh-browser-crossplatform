// @vitest-environment jsdom

/**
 * 重写 worker 时发现的缺陷的回归测试。
 *
 * 这里的每个用例都复现那次重写里的一个真实 bug，所以将来任何
 * 把其中任何一个重新引入的改动都会大声失败，而不是被发布出去：
 *
 * 1. keepalive 抢回了一个已经把槽位交给另一个浏览器的 bridge，
 * 2. 关掉不受限访问，一次已经获批的调用却还在跑，
 * 3. 两次设置写入抢着写，结果较早的那次最后落盘，
 * 4. 一次超时的标签页重绑之后仍然挪动了受控标签页，
 * 5. 输入的文本和完整 URL 在控制条历史里越堆越多。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { CONTROL_PORT_NAME, type ControlState } from '../src/settings.ts'

const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
const KEEPALIVE_ALARM = 'dsh-bridge-keepalive'
const BRIDGE_URL = 'wss://bridge.example/ext/bridge'
const REBIND_TIMEOUT_MS = 10_000

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
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
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

function controlPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: CONTROL_PORT_NAME, postMessage, onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

interface ControlMessageLike {
  type?: string
  state?: ControlState
  entry?: { id?: string; name?: string; summary?: string; state?: string }
  id?: string
  ok?: boolean
  error?: string
}

function sentMessages(postMessage: ReturnType<typeof vi.fn>): ControlMessageLike[] {
  return postMessage.mock.calls.map((call) => call[0] as ControlMessageLike)
}

function latestState(postMessage: ReturnType<typeof vi.fn>): ControlState | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'state').at(-1)?.state
}

/** 控制条见过的每一行活动记录，按它看到的顺序排。 */
function activityRows(postMessage: ReturnType<typeof vi.fn>): NonNullable<ControlMessageLike['entry']>[] {
  return sentMessages(postMessage).filter((message) => message.type === 'activity').map((message) => message.entry!)
}

/** 最新一份完整状态快照带的活动列表。 */
function activitySnapshot(postMessage: ReturnType<typeof vi.fn>): ControlState['activity'] {
  return latestState(postMessage)?.activity ?? []
}

async function openBridge(socket: FakeWebSocket): Promise<void> {
  socket.open()
  await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' })) })
}

function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  /** webNavigation 报告的 frame 文档；DOM 工具至少需要 frame 0。 */
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const onRuntimeMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const frames = options.frames ?? [{ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: 'https://example.com/1' }]
  const tabs = {
    get: vi.fn(async (tabId: number) => htmlTab(tabId)),
    query: vi.fn(options.tabQuery ?? (async () => [htmlTab(1)])),
    remove: vi.fn(async () => {}),
    create: vi.fn(async () => htmlTab(1)),
    update: vi.fn(async () => {
      // 页面级导航要等替换文档自报身份之后才算「就绪」；
      // worker 会在派发之前装好那个监听器，
      // 所以在这里作答是确定性的，不是一场时序竞争。
      onRuntimeMessage.emit(
        { type: 'DSH_CONTENT_READY' },
        { tab: { id: 1 }, frameId: 0, documentId: 'doc-2', url: 'https://example.com/reset' } as chrome.runtime.MessageSender,
        () => {},
      )
      return htmlTab(1)
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    sendMessage: vi.fn(options.tabSendMessage ?? (async () => ({ ok: true, result: { text: 'snapshot' } }))),
    reload: vi.fn(async () => {}),
    onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
    onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
    onReplaced: chromeEvent<[number, number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      openPopup: vi.fn(async () => {}),
      // 工具栏图标没有 popup：开页面靠的就是这个监听器。
      onClicked: chromeEvent<[chrome.tabs.Tab]>(),
    },
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
      onButtonClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: onRuntimeMessage,
      onInstalled: chromeEvent<[]>(),
    },
    storage: {
      local: {
        get: vi.fn(options.localGet ?? (async () => ({}))),
        set: vi.fn(options.localSet ?? (async () => {})),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    },
    tabs,
    webNavigation: { getAllFrames: vi.fn(async () => frames), onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>() },
    scripting: { executeScript: vi.fn(async () => []) },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onAlarm, onConnect, tabs }
}

beforeEach(() => {
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('bridge replacement (close code 4000)', () => {
  it('does not reclaim the slot on the keepalive heartbeat', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    // bridge 把唯一的槽位给了另一个浏览器。
    socket.close(4000, 'replaced')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    // 心跳必须放过另一个浏览器，不能每三十秒把它
    // 来回踢一次。
    chromeMock.onAlarm.emit({ name: KEEPALIVE_ALARM, scheduledTime: Date.now() })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(FakeWebSocket.instances).toHaveLength(1)

    // 显式的用户操作仍然可以再认领这个槽位。
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    control.onMessage.emit({ type: 'settings.update', id: 'reclaim', settings: { bridgeUrl: BRIDGE_URL } })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'reclaim', ok: true })
  })
})

describe('revoking unrestricted browser access', () => {
  it('cancels a call that captured the grant before it reaches the page', async () => {
    let settings: Record<string, unknown> = { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: true }
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: settings }),
      localSet: async (items) => { settings = items.dshSettings as Record<string, unknown> },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })

    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    // 先来一次快照：元素寻址是针对 worker 最后看到的文档
    // 做校验的，跟真实会话里的做法完全一致。它必须在
    // `sendMessage` 开始挂起之前完成。
    socket.receive({ t: 'tool.call', id: 'snap-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-1', ok: true }))
    })
    const pendingDispatch = new Promise<unknown>(() => {})
    chromeMock.tabs.sendMessage.mockImplementation(() => pendingDispatch)
    socket.receive({
      t: 'tool.call',
      id: 'call-1',
      name: 'browser_click',
      args: { index: 3 },
      expiresAt: Date.now() + 60_000,
    })

    control.onMessage.emit({
      type: 'settings.update',
      id: 'revoke-1',
      settings: { unrestrictedBrowserAccess: false },
    })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'revoke-1', ok: true })
    })

    // 存下来的正是那次撤销，而这次调用从没回答成功过。
    expect(settings.unrestrictedBrowserAccess).toBe(false)
    expect(socket.sent).toContainEqual(expect.objectContaining({
      t: 'tool.result',
      id: 'call-1',
      ok: false,
    }))
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-1', ok: true }))
  })

  it('persists the restrictive value and still answers the call it withdrew', async () => {
    let settings: Record<string, unknown> = { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: true }
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: settings }),
      localSet: async (items) => { settings = items.dshSettings as Record<string, unknown> },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    // 先来一次快照基线，然后是 worker 派发的一次页面动作。
    socket.receive({ t: 'tool.call', id: 'snap-4', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-4', ok: true }))
    })
    socket.receive({ t: 'tool.call', id: 'call-4', name: 'browser_click', args: { index: 1 }, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(2)
    })

    control.onMessage.emit({
      type: 'settings.update',
      id: 'revoke-4',
      settings: { unrestrictedBrowserAccess: false },
    })
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'revoke-4', ok: true })
    })

    // 存下来的正是那次撤销，控制条也被告知了，而对
    // 那次在途调用的答复仍然会到，所以模型永远不会被晾着等。
    expect(settings.unrestrictedBrowserAccess).toBe(false)
    expect(latestState(control.postMessage)?.settings.unrestrictedBrowserAccess).toBe(false)
    expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-4' }))
  })
})

describe('settings write ordering', () => {
  it('keeps the last of two rapid updates in storage', async () => {
    let settings: Record<string, unknown> = { bridgeUrl: BRIDGE_URL }
    const written: Record<string, unknown>[] = []
    let releaseSecondWrite!: () => void
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: settings }),
      localSet: (items) => {
        // 只有设置写入属于这个测试计数的序列。worker 的
        // 诊断探测会把自己的键写进同一个存储，放它
        // 进来会重新编号这个测试推理的那些写入。
        if (!('dshSettings' in items)) return Promise.resolve()
        const index = written.length
        settings = items.dshSettings as Record<string, unknown>
        written.push(settings)
        // 写入 0 是启动迁移，写入 1 是第一个 patch，写入 2 是
        // 第二个。把*中间*那次拖慢，正是暴露缺少队列的方式：
        // 写入 2 先落盘，然后过期的写入 1 最后落盘，
        // 悄悄撤销用户后来做出的选择。
        if (index !== 1) return Promise.resolve()
        return new Promise<void>((resolve) => { releaseSecondWrite = resolve })
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
    await vi.waitFor(() => { expect(written).toHaveLength(1) })

    control.onMessage.emit({ type: 'settings.update', id: 'w1', settings: { sharePageContent: 'off' } })
    await vi.waitFor(() => { expect(written).toHaveLength(2) })
    control.onMessage.emit({ type: 'settings.update', id: 'w2', settings: { approvalNotifications: false } })
    // 第一个还开着的时候，排队的第二个 patch 绝不能到达存储。
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(written).toHaveLength(2)

    releaseSecondWrite()
    await vi.waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'w2', ok: true })
    })
    expect(written).toHaveLength(3)

    const persisted = settings as { sharePageContent?: string; approvalNotifications?: boolean }
    // 这里原先断言 `'off'`。那一档已删除，而归一化把它折算成 `'ask'`
    //（存过旧值的用户当初选的是更严格的一档，不该被降级成"什么都不问"）。
    // 所以这条断言顺带把那条迁移路径也钉住了 —— 而且走的是真实的设置写入。
    expect(persisted.sharePageContent).toBe('ask')
    expect(persisted.approvalNotifications).toBe(false)
  })
})

describe('tab rebind deadline', () => {
  it('leaves the binding alone when the tab query resolves after the deadline', async () => {
    let releaseQuery!: (tabs: chrome.tabs.Tab[]) => void
    let slow = false
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }),
      tabQuery: () => {
        if (!slow) return Promise.resolve([htmlTab(1)])
        return new Promise<chrome.tabs.Tab[]>((resolve) => { releaseQuery = resolve })
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
    // 第一次成功的页面工具把受控标签页绑到 tab 1。
    socket.receive({ t: 'tool.call', id: 'bind-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'bind-1', ok: true }))
      expect(latestState(control.postMessage)?.affinity.controlled?.tabId).toBe(1)
    })

    vi.useFakeTimers()
    slow = true
    control.onMessage.emit({ type: 'affinity.rebind', id: 'slow-rebind' })
    await vi.advanceTimersByTimeAsync(REBIND_TIMEOUT_MS + 10)
    expect(control.postMessage).toHaveBeenCalledWith({
      type: 'affinity.rebind.result',
      id: 'slow-rebind',
      ok: false,
      error: 'timeout',
    })

    // 迟到的那份答复在用户已经被告知尝试失败之后才到。
    vi.useRealTimers()
    releaseQuery([htmlTab(2)])
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(latestState(control.postMessage)?.affinity.controlled?.tabId).toBe(1)
    const results = sentMessages(control.postMessage)
      .filter((message) => message.type === 'affinity.rebind.result' && message.id === 'slow-rebind')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, error: 'timeout' })
  })
})

describe('control strip activity privacy', () => {
  it('never echoes typed text or a full URL into the activity list', async () => {
    const chromeMock = mockChrome({
      // 有了不受限访问，这件事只关乎日志记了什么，不关乎
      // 怎么回答审批。
      localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: true } }),
      tabSendMessage: async () => ({ ok: true, result: { text: 'typed' } }),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await openBridge(socket)
    socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    // 先来一次快照：元素寻址是针对 worker 最后看到的文档
    // 做校验的，跟真实会话里的做法完全一致。
    socket.receive({ t: 'tool.call', id: 'snap-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap-1', ok: true }))
    })
    socket.receive({
      t: 'tool.call',
      id: 'type-1',
      name: 'browser_type',
      args: { index: 2, text: 'hunter2-correct-horse' },
      expiresAt: Date.now() + 60_000,
    })
    socket.receive({
      t: 'tool.call',
      id: 'nav-1',
      name: 'browser_navigate',
      args: { url: 'https://example.com/reset?token=secret-value' },
      expiresAt: Date.now() + 60_000,
    })
    await vi.waitFor(() => {
      const rows = activityRows(control.postMessage)
      expect(rows.some((row) => row.id === 'type-1' && row.state === 'done')).toBe(true)
      expect(rows.some((row) => row.id === 'nav-1' && row.state === 'done')).toBe(true)
    })

    // 像控制条那样请求一份新快照，这样断言读到的
    // 是权威列表，不是最后到达的那次推送。
    control.onMessage.emit({ type: 'state.request' })
    await vi.waitFor(() => {
      expect(activitySnapshot(control.postMessage)).toHaveLength(3)
    })

    const serialized = JSON.stringify(activitySnapshot(control.postMessage))
    expect(serialized).not.toContain('hunter2-correct-horse')
    expect(serialized).not.toContain('secret-value')
    // 那些有用、非机密的部分还在。
    expect(serialized).toContain('https://example.com')
    expect(serialized).toContain('21 chars')
  })
})
