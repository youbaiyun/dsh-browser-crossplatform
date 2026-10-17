// @vitest-environment jsdom

/**
 * 浏览器端跑 worker 的工具调用连续性。
 *
 * 对话归桌面 GUI 所有，所以 `browser_*` 调用从
 * bridge socket 到达，也在那里被应答：它从不属于恰好开着的
 * 控制条。这顶掉了旧的会话检查点测试套件，那套
 * 按对话保存的页面状态已随聊天面板一起移除。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { CONTROL_PORT_NAME, type ControlState } from '../src/settings.ts'

const BRIDGE_URL = 'wss://bridge.example/ext/bridge'
const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

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
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

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

/** 在审批提示被移开的情况下启动 worker（不受限制的访问）。 */
async function bootWorker(tabRemove: (tabId: number) => Promise<void> = async () => {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const remove = vi.fn(tabRemove)
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      // 工具栏图标没有 popup：点击它会打开控制页。
      onClicked: chromeEvent<[chrome.tabs.Tab]>(),
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      onAlarm: chromeEvent<[chrome.alarms.Alarm]>(),
    },
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
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
      onInstalled: chromeEvent<[]>(),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({
          dshSettings: { bridgeUrl: BRIDGE_URL, unrestrictedBrowserAccess: true },
        })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => htmlTab(tabId)),
      query: vi.fn(async () => [htmlTab(1)]),
      remove,
      create: vi.fn(async () => htmlTab(1)),
      sendMessage: vi.fn(async () => {}),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  vi.stubGlobal('WebSocket', FakeWebSocket)

  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
  const socket = FakeWebSocket.instances[0]!
  socket.open()
  // 客户端在发 `hello` 的那一轮里挂上自己的帧监听器。
  await vi.waitFor(() => {
    expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' }))
  })
  socket.receive({ t: 'hello.ok', caps: HELLO_CAPS })
  return { onConnect, remove, socket }
}

type MessageSpy = ReturnType<typeof vi.fn>

function latestState(postMessage: MessageSpy): ControlState | undefined {
  return postMessage.mock.calls
    .map((call) => call[0] as { type?: string; state?: ControlState })
    .filter((message) => message.type === 'state')
    .at(-1)?.state
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background tool-call continuity', () => {
  it('answers a tool call while no control strip is open', async () => {
    const { remove, socket } = await bootWorker()

    socket.receive({
      t: 'tool.call',
      id: 'close-1',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })

    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'close-1', ok: true }))
    })
    expect(remove).toHaveBeenCalledWith(1)
  })

  it('finishes an in-flight tool call after the strip that was watching it disconnects', async () => {
    let finishClose!: () => void
    const close = new Promise<void>((resolve) => { finishClose = resolve })
    const { onConnect, remove, socket } = await bootWorker(async () => { await close })

    const control = controlPort()
    onConnect.emit(control.port)
    await vi.waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })

    socket.receive({
      t: 'tool.call',
      id: 'close-1',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(remove).toHaveBeenCalledWith(1) })

    control.onDisconnect.emit()
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'close-1' }))

    finishClose()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'close-1', ok: true }))
    })

    // 稍后才打开的控制条照样能从自己的视图状态得知结果。
    const reopened = controlPort()
    onConnect.emit(reopened.port)
    expect(latestState(reopened.postMessage)?.activity).toContainEqual(expect.objectContaining({
      id: 'close-1',
      state: 'done',
    }))
  })
})
