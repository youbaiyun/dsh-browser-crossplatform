// @vitest-environment jsdom

/**
 * worker 的会话、助手流和手动输入命令测试。
 *
 * 整页控制 UI 新加的两项能力绝不能悄悄退化：
 * 在那里敲的指令经 bridge 转发给桌面 dsh 模型，
 * 流式回复、回合边界和工具进度再回传——
 * 只一个会话、只针对活跃会话、不复现任何历史——而在那里敲的
 * `browser_*` 命令就在本地走模型调用用的同一条
 * 派发路径，而且永远不弹审批提示。
 *
 * 这些测试用一个伪造的 `chrome.*` 和一个伪造的
 * WebSocket 启动真实 worker，与 `background-bridge-lifecycle.spec.ts` 完全一样。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
import { CONTROL_PORT_NAME, type ControlState, type TimelineEntry } from '../src/settings.ts'

const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
const BRIDGE_URL = 'wss://bridge.example/ext/bridge'
const SESSION_ID = 'session-7'

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

type MessageSpy = ReturnType<typeof vi.fn>

/** worker 推给控制页的一条消息，带上待测字段。 */
interface ControlMessageLike {
  type?: string
  state?: ControlState
  entry?: { id?: string; kind?: string; name?: string; state?: string }
  event?: { sessionId?: string; kind?: string; payload?: unknown }
  request?: { id?: string; action?: string }
  sessionId?: string
  id?: string
  ok?: boolean
  error?: string
  result?: unknown
}

/** worker 写入 bridge socket 的一个帧。 */
interface SentFrame {
  t?: string
  id?: string
  method?: string
  payload?: Record<string, unknown>
  ok?: boolean
  result?: unknown
  name?: string
}

function sentMessages(postMessage: MessageSpy): ControlMessageLike[] {
  return postMessage.mock.calls.map((call) => call[0] as ControlMessageLike)
}

function latestState(postMessage: MessageSpy): ControlState | undefined {
  return sentMessages(postMessage).filter((message) => message.type === 'state').at(-1)?.state
}

function streamMessages(postMessage: MessageSpy): NonNullable<ControlMessageLike['event']>[] {
  return sentMessages(postMessage)
    .filter((message) => message.type === 'session.stream')
    .map((message) => message.event!)
}

function sessionEvents(postMessage: MessageSpy): ControlMessageLike[] {
  return sentMessages(postMessage).filter((message) => message.type === 'session.event')
}

function activityRows(postMessage: MessageSpy): NonNullable<ControlMessageLike['entry']>[] {
  return sentMessages(postMessage).filter((message) => message.type === 'activity').map((message) => message.entry!)
}

function approvalRequest(postMessage: MessageSpy): { id: string; action: string } | undefined {
  const request = sentMessages(postMessage)
    .filter((message) => message.type === 'approval.request')
    .at(-1)?.request
  if (request === undefined || typeof request.id !== 'string') return undefined
  return { id: request.id, action: String(request.action ?? '') }
}

function timelineOf(postMessage: MessageSpy): TimelineEntry[] {
  return latestState(postMessage)?.timeline ?? []
}

function sent(socket: FakeWebSocket): SentFrame[] {
  return socket.sent as SentFrame[]
}

function rpcFrame(socket: FakeWebSocket, method: string): SentFrame | undefined {
  return sent(socket).find((frame) => frame.t === 'rpc' && frame.method === method)
}

/**
 * 某个方法发出的所有帧。
 *
 * 某个功能会合法地把同一次调用发好几遍时就需要它——「工作区内」
 * 会给每个对话各开一个 follower——而一个返回「第一个匹配」的辅助函数会把
 * 同一个帧报告两次。
 *
 * @param socket - 伪造的连接。
 * @param method - 要收集的 gateway 方法。
 * @returns 帧，按发送顺序排列。
 */
function rpcFrames(socket: FakeWebSocket, method: string): SentFrame[] {
  return sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === method)
}

/**
 * 带预算的 `vi.waitFor`，为繁忙的机器准备的。
 *
 * 默认是一秒，而整套测试跑起来时有 42 个 spec 文件同时在飞：
 * 一个单独跑约 370ms 的用例曾在 1008ms 时失败——恰好卡在
 * 默认值那一毫秒上。下面的等待只是问 worker 有没有走到某处，所以
 * 它已经到了的话，更长的预算不用付任何代价。
 */
const waitFor = <T>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 3_000 })

/** 等到 worker 已经向 gateway 请求过 `method`。 */
async function waitForRpc(socket: FakeWebSocket, method: string): Promise<SentFrame> {
  return waitFor(() => {
    const frame = rpcFrame(socket, method)
    expect(frame, `gateway call ${method}`).toBeDefined()
    return frame!
  })
}

/** 像 bridge 那样回应一次 gateway 调用：一个 ServerResponse 信封。 */
function answerRpc(socket: FakeWebSocket, request: SentFrame, business: Record<string, unknown>): void {
  socket.receive({
    t: 'rpc.result',
    id: request.id,
    ok: true,
    result: { type: 'server-response', rpcId: request.id, result: business },
  })
}

/** 已经请求过会话的控制页；之后每次推送都能看到。 */
function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  // worker 在这里订阅内容脚本的「文档就绪」
  // 握手，所以测试需要一个句柄来触发它。
  const onMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  // 暴露出来是为了让测试断言 worker 存下了什么。面板记住
  // 「开一个新会话」正在用哪个对话，而这次写入就是该功能本身。
  const storage = {
    local: {
      get: vi.fn(options.localGet ?? (async () => ({}))),
      set: vi.fn(options.localSet ?? (async () => {})),
      remove: vi.fn(async () => {}),
    },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
  }
  const frames = options.frames ?? [{ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: 'https://example.com/1' }]
  const tabs = {
    get: vi.fn(async (tabId: number) => htmlTab(tabId)),
    query: vi.fn(options.tabQuery ?? (async () => [htmlTab(1)])),
    remove: vi.fn(async () => {}),
    create: vi.fn(async () => htmlTab(1)),
    update: vi.fn(async () => htmlTab(1)),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    sendMessage: vi.fn(options.tabSendMessage ?? (async () => ({ ok: true, result: { text: 'ok' } }))),
    onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
    onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
    onReplaced: chromeEvent<[number, number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  const windows = {
    WINDOW_ID_NONE: -1,
    getLastFocused: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => ({ id: 1 })),
    onFocusChanged: chromeEvent<[number]>(),
    onRemoved: chromeEvent<[number]>(),
  }
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      // 工具栏图标没有 popup：点击它会打开控制页。
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
      onMessage,
      onInstalled: chromeEvent<[]>(),
    },
    storage,
    tabs,
    webNavigation: {
      getAllFrames: vi.fn(async () => frames),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    windows,
  } as unknown as typeof chrome)
  return { onAlarm, onConnect, onMessage, storage, tabs, windows }
}

/** 启动 worker、连上它的 bridge，并打开一个控制页。 */
async function boot(
  settings: Record<string, unknown> = {},
  policy: { openPagesForUser: boolean } = { openPagesForUser: true },
  extraStorage: Record<string, unknown> = {},
) {
  const chromeMock = mockChrome({
    localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL, ...settings }, ...extraStorage }),
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  loadedWorker = await import('../src/background/index.ts')
  // 至少一次，不是恰好一次：发现尝试一慢，worker 排定的
  // 重试就会在第一个 socket 建好之后触发，于是统计拨号次数的
  // 测试会因为一次合法重试而挂。下面用的 socket 始终是第一个——
  // 它是这个测试打开的那个，也是它的握手所走的那个。
  await waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
  const socket = FakeWebSocket.instances[0]!
  socket.open()
  await waitFor(() => {
    expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'hello' }))
  })
  // policy 跟着握手一起来，所以必须在这里选定：连接一认证完，
  // 第二个 `hello.ok` 就会被忽略，这是对的
  // ——桌面应用不会在连接中途改变主意。
  socket.receive({ t: 'hello.ok', caps: HELLO_CAPS, policy })
  const control = controlPort()
  chromeMock.onConnect.emit(control.port)
  await waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('connected') })
  control.postMessage.mockClear()
  return { chromeMock, control, socket }
}

/** 一个 bridge 推送事件，按 dsh Host 适配器的投影形式。 */
function pushEvent(socket: FakeWebSocket, method: string, payload: unknown): void {
  socket.receive({ t: 'event', frame: { rpcId: crypto.randomUUID(), method, payload } })
}

/**
 * 这个测试套件最后加载的 worker 模块。
 *
 * 一个从不回答的 bridge 会在模块里留下排队中的发现重试，那个
 * 定时器会比引发它的测试活得久：不取消它，它就会
 * 在*下一个*测试里触发，拨一个没人要的 socket，于是
 * `FakeWebSocket.instances` 里就有两个条目，后面某个测试就会因为一个
 * 跟它检查的东西毫无关系的原因挂掉。这和
 * `background-bridge-lifecycle.spec.ts` 使用的拆除方式相同，这里需要它也是出于同样的
 * 原因一样——这里有个测试绑了会话，就起动了这条探测链。
 */
let loadedWorker: { cancelPendingWork?: () => void } | undefined

afterEach(() => {
  loadedWorker?.cancelPendingWork?.()
  loadedWorker = undefined
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('session lifecycle', () => {
  it('creates one session lazily on the first prompt and forwards the exact prompt shape', async () => {
    const { control, socket } = await boot()

    expect(rpcFrame(socket, 'session.create')).toBeUndefined()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'open the docs' })

    const created = await waitForRpc(socket, 'session.create')
    expect(created.payload).toEqual({})
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })

    const prompted = await waitForRpc(socket, 'session.prompt')
    const payload = prompted.payload!
    expect(payload.sessionId).toBe(SESSION_ID)
    expect(payload.mode).toBe('queue')
    // 把那个标记原样写出来：这是防冒充的契约，所以
    // 测试里固定字面量，而不是拿常量和它自己比。
    expect(JSON.stringify(payload.content)).toBe(JSON.stringify([{ type: 'text', text: '[用户·浏览器面板] open the docs' }]))
    // 按契约 zone 是可选的，但除此之外什么都不能有。
    expect(payload.clientTimeZone === undefined || typeof payload.clientTimeZone === 'string').toBe(true)
    answerRpc(socket, prompted, { ok: true, value: {} })

    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: true,
        sessionId: SESSION_ID,
      })
    })
    // worker 会在自己的状态里报告会话和排队中的 prompt。
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session).toEqual({
        id: SESSION_ID,
        turn: 'idle',
        pendingPrompt: true,
      })
      expect(timelineOf(control.postMessage).filter((entry) => entry.kind === 'request'))
        .toEqual([expect.objectContaining({ kind: 'request', text: 'open the docs', state: 'done' })])
    })

    // 第二次 prompt 复用同一个会话：一个 worker 恰好一个会话。
    control.onMessage.emit({ type: 'session.prompt', id: 'p2', text: 'and the next page' })
    await waitFor(() => {
      expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.prompt')).toHaveLength(2)
    })
    const prompts = sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.prompt')
    // 每个面板 prompt 都带上标记，不只是第一个。
    expect(prompts[1]!.payload!.content).toEqual([{ type: 'text', text: '[用户·浏览器面板] and the next page' }])
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(1)
  })

  it('rejects a prompt with a clear message while the bridge is not connected', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: {} }) })
    // 扩展总是会拨号；没人应答才是它停下来的原因。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('stopped') })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: false,
        error: expect.stringContaining('not connected'),
      })
    })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('rejects a pending gateway call when the socket drops, and drops the optimistic request row', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    await waitForRpc(socket, 'session.create')

    // bridge 把唯一的槽位给了另一个浏览器：这次调用永远
    // 等不到回答，所以必须现在告诉页面，而不是 30 秒后。
    socket.close(4000, 'replaced')
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: false,
        error: 'The dsh bridge was stopped before the gateway answered.',
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(timelineOf(control.postMessage)).toEqual([])
      expect(latestState(control.postMessage)?.session.pendingPrompt).toBe(false)
    })
  })

  it('surfaces a gateway business failure as its own message', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    const created = await waitForRpc(socket, 'session.create')
    // 一个传输层收下了、但 gateway 拒了的回复。
    answerRpc(socket, created, { ok: false, error: { code: 'bad-request', message: 'the session limit is reached' } })

    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'p1',
        ok: false,
        error: 'the session limit is reached',
      })
    })
    expect(rpcFrame(socket, 'session.prompt')).toBeUndefined()
  })

  it('cancels the remembered session', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    const prompted = await waitForRpc(socket, 'session.prompt')
    answerRpc(socket, prompted, { ok: true, value: {} })

    control.onMessage.emit({ type: 'session.cancel', id: 'c1' })
    const cancel = await waitForRpc(socket, 'session.cancel')
    expect(cancel.payload).toEqual({ sessionId: SESSION_ID })
    answerRpc(socket, cancel, { ok: true, value: {} })

    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'c1',
        ok: true,
        sessionId: SESSION_ID,
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.turn).toBe('idle')
    })
  })

  it('reports a cancel with no session instead of calling the gateway', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.cancel', id: 'c1' })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'c1',
        ok: false,
        error: expect.stringContaining('no dsh session'),
      })
    })
    expect(rpcFrame(socket, 'session.cancel')).toBeUndefined()
  })
})

describe('assistant stream and turn progress', () => {
  it('relays stream and event frames for the active session only', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })
    control.postMessage.mockClear()

    const delta = { revision: 1, attemptId: 'attempt-1', type: 'chunk', index: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }
    pushEvent(socket, 'session/assistant-stream', { sessionId: SESSION_ID, frame: delta })
    pushEvent(socket, 'session/assistant-stream', {
      sessionId: 'someone-else',
      frame: { ...delta, chunk: { type: 'text-delta', index: 0, text: 'NOPE' } },
    })
    const baseline = { revision: 2, activeAttempt: { attemptId: 'attempt-2', stream: [], nextIndex: 0 } }
    pushEvent(socket, 'session/assistant-stream', {
      sessionId: SESSION_ID,
      snapshotId: 'snap-1',
      frame: { type: 'snapshot', baseline },
    })
    pushEvent(socket, 'session/event', {
      sessionId: SESSION_ID,
      event: { type: 'turn/start', seq: 1, time: 1, data: {} },
    })
    pushEvent(socket, 'session/event', {
      sessionId: 'someone-else',
      event: { type: 'turn/end', seq: 2, time: 2, data: {} },
    })

    const streams = streamMessages(control.postMessage)
    expect(streams).toHaveLength(2)
    // delta 自己就是帧；快照则把 id 留在帧旁边。
    expect(streams[0]).toEqual({ sessionId: SESSION_ID, kind: 'delta', payload: delta })
    expect(streams[1]).toEqual({
      sessionId: SESSION_ID,
      kind: 'snapshot',
      payload: { snapshotId: 'snap-1', frame: { type: 'snapshot', baseline } },
    })

    const events = sessionEvents(control.postMessage)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: SESSION_ID, event: { type: 'turn/start', seq: 1 } })

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.turn).toBe('running')
    })
  })

  it('drives session.turn from turn/start and turn/end and clears pendingPrompt', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'summarize it' })
    const prompted = await waitForRpc(socket, 'session.prompt')
    answerRpc(socket, prompted, { ok: true, value: {} })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.pendingPrompt).toBe(true)
    })

    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/start', seq: 3, time: 3, data: {} } })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.session.turn).toBe('running')
      expect(state.session.pendingPrompt).toBe(false)
    })

    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/end', seq: 9, time: 9, data: {} } })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.turn).toBe('idle')
    })
  })

  it('keeps one assistant timeline row per turn and replaces its text as deltas arrive', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })

    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/start', seq: 1, time: 1, data: {} } })
    const first = { revision: 1, attemptId: 'a1', type: 'chunk', index: 0, chunk: { type: 'text-delta', index: 0, text: 'Hello' } }
    pushEvent(socket, 'session/assistant-stream', { sessionId: SESSION_ID, frame: first })
    const row = await waitFor(() => {
      const rows = timelineOf(control.postMessage).filter((entry) => entry.kind === 'assistant')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.text).toBe('Hello')
      return rows[0]!
    })

    // 第二个 delta 必须替换那一行的文本，绝不能新增一行。
    pushEvent(socket, 'session/assistant-stream', {
      sessionId: SESSION_ID,
      frame: { ...first, index: 1, revision: 2, chunk: { type: 'text-delta', index: 0, text: ', world' } },
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const rows = timelineOf(control.postMessage).filter((entry) => entry.kind === 'assistant')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: row.id, kind: 'assistant', text: 'Hello, world' })
    })

    // 这一步以持久化的消息为准，不会把它重复算一次。
    pushEvent(socket, 'session/event', {
      sessionId: SESSION_ID,
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 4,
        data: { message: { content: [{ type: 'text', text: 'Hello, world' }] } },
      },
    })
    pushEvent(socket, 'session/event', { sessionId: SESSION_ID, event: { type: 'turn/end', seq: 5, time: 5, data: {} } })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const rows = timelineOf(control.postMessage).filter((entry) => entry.kind === 'assistant')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: row.id, text: 'Hello, world', state: 'done' })
    })
  })

  it('caps the timeline and drops the oldest rows', async () => {
    const { control, socket } = await boot({ unrestrictedBrowserAccess: true })
    control.onMessage.emit({ type: 'session.create', id: 's1' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 's1', ok: true, sessionId: SESSION_ID })
    })

    // 205 次模型驱动的读取超过了 200 行的上限，最旧的五条
    // 被挤了出去。它们一次性推完：行序就是帧序，因为
    // 一步在派发等待任何东西之前就已经追加了。
    for (let index = 0; index < 205; index += 1) {
      socket.receive({ t: 'tool.call', id: `call-${index}`, name: 'browser_list_tabs', args: {}, expiresAt: Date.now() + 60_000 })
    }
    await waitFor(() => {
      expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-204', ok: true }))
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const entries = timelineOf(control.postMessage)
      expect(entries).toHaveLength(200)
      expect(entries[0]!.callId).toBe('call-5')
      expect(entries.at(-1)!.callId).toBe('call-204')
    })
  })
})

describe('@open directive', () => {
  /**
   * 让 `tabId` 的下一次导航宣告一个就绪文档。
   *
   * worker 会在调用 `tabs.update` 之前就注册好它的「文档就绪」
   * 监听器，所以那个宣告必须*因为*这次调用才发生。
   * 改从测试体里触发它，就是一场看时序的赌局：worker
   * 可能赢也可能输——这个测试的第一版
   * 会不稳定而不是写错，原因就在这里。
   */
  const arrangeNavigation = (
    chromeMock: ReturnType<typeof mockChrome>,
    tabId: number,
    url: string,
  ): void => {
    chromeMock.tabs.update.mockImplementation(async () => {
      chromeMock.onMessage.emit(
        { type: 'DSH_CONTENT_READY' },
        { tab: { id: tabId }, frameId: 0, documentId: 'doc-next', url } as chrome.runtime.MessageSender,
        () => {},
      )
      return { ...htmlTab(tabId), url }
    })
  }

  it('refuses @open when the desktop app has turned the permission off', async () => {
    // 这个开关归桌面应用，所以扩展绝不能对它有自己的
    // 主意：应用一收回权限，命令就必须停下来。
    const { chromeMock, control } = await boot({}, { openPagesForUser: false })
    chromeMock.tabs.create.mockResolvedValue(htmlTab(42))

    control.onMessage.emit({ type: 'open.run', id: 'o1', url: 'https://example.com/', pace: 'fast', pin: true })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o1',
        ok: false,
        error: expect.stringMatching(/openPagesForUser|turned off|关闭/),
      })
    })
    // 什么都没打开，标签页绑定也没被动过。
    expect(chromeMock.tabs.create).not.toHaveBeenCalled()
  })

  it('refuses @open before any handshake has granted the permission', async () => {
    // 按失败关闭的方向来。一份丢了或读不出来的 policy 必须读作
    // 「不允许」：要是缺失就等于许可，一次坏掉的握手就能
    // 发出一项用户从没授予过的授权。
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: BRIDGE_URL } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    // 至少一次，不是恰好一次：发现尝试一慢，worker 排定的
  // 重试就会在第一个 socket 建好之后触发，于是统计拨号次数的
  // 测试会因为一次合法重试而挂。下面用的 socket 始终是第一个——
  // 它是这个测试打开的那个，也是它的握手所走的那个。
  await waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await waitFor(() => {
      expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'hello' }))
    })
    // 已连接，但 `hello.ok` 还没到：还没有任何 policy 生效。
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    chromeMock.tabs.create.mockResolvedValue(htmlTab(42))

    control.onMessage.emit({ type: 'open.run', id: 'o1', url: 'https://example.com/', pace: 'fast', pin: true })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o1',
        ok: false,
        error: expect.stringMatching(/openPagesForUser|turned off|关闭/),
      })
    })
    expect(chromeMock.tabs.create).not.toHaveBeenCalled()
  })

  it('does not raise the panel on its own when pages may not be opened', async () => {
    // 自动打开是「模型马上要给你看某样东西」的一部分，
    // 所以它绝不能比应用关掉它的那一下活得更久。
    const { chromeMock, socket } = await boot({ autoOpenPanel: true }, { openPagesForUser: false })

    socket.receive({
      t: 'tool.call',
      id: 'snap-1',
      name: 'browser_snapshot',
      args: {},
      expiresAt: Date.now() + 10_000,
    })
    await waitFor(() => {
      expect(socket.sent.some((frame) => (frame as { t?: string }).t === 'tool.result')).toBe(true)
    })
    // `windows.getLastFocused` 只出现在自动打开这条路上——一次工具调用
    // 解析自己的目标标签页靠 `tabs.query`，所以这个信号
    // 才能把「面板被抬到前台」和普通派发分开。
    expect(chromeMock.windows.getLastFocused).not.toHaveBeenCalled()
  })

  it('opens the tab in front of the user without involving the model', async () => {
    const { chromeMock, control, socket } = await boot()
    chromeMock.tabs.create.mockResolvedValue(htmlTab(42))
    arrangeNavigation(chromeMock, 42, 'https://store.steampowered.com/')

    control.onMessage.emit({ type: 'open.run', id: 'o1', url: 'https://store.steampowered.com/', pace: 'fast', pin: true })
    await waitFor(() => {
      // 刻意放前台：意义全在于让用户看得见它。
      expect(chromeMock.tabs.create).toHaveBeenCalledWith({ active: true, windowId: 1 })
    })
    await waitFor(() => {
      expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { url: 'https://store.steampowered.com/' })
    })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o1',
        ok: true,
        result: expect.objectContaining({ url: 'https://store.steampowered.com/', tabId: 42, pinned: true }),
      })
    })

    // 这些工具现在作用于用户要求查看的那个标签页。
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.affinity.controlled?.tabId).toBe(42)
    })
    // 而且什么都没发给模型：这条指令不算一次请求。
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.prompt')).toHaveLength(0)
  })

  it('refuses a non-http address before opening anything', async () => {
    const { chromeMock, control } = await boot()
    control.onMessage.emit({ type: 'open.run', id: 'o2', url: 'file:///C:/windows/system32', pace: 'fast', pin: true })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o2',
        ok: false,
        error: expect.stringMatching(/http/),
      })
    })
    expect(chromeMock.tabs.create).not.toHaveBeenCalled()
  })

  it('leaves the binding alone when pin is off', async () => {
    const { chromeMock, control } = await boot()
    chromeMock.tabs.create.mockResolvedValue(htmlTab(43))
    arrangeNavigation(chromeMock, 43, 'https://example.com/')

    control.onMessage.emit({ type: 'open.run', id: 'o3', url: 'https://example.com/', pace: 'fast', pin: false })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'o3',
        ok: true,
        result: expect.objectContaining({ pinned: false }),
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.affinity.controlled).toBeNull()
    })
  })
})

describe('conversation routing', () => {
  it('gives the panel its own session by default', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    // `fresh` 会新建一个，而不是写进桌面已经开着的那个里。
    const created = await waitForRpc(socket, 'session.create')
    expect(created.payload).toEqual({})
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.id).toBe(SESSION_ID)
    })
  })

  it('continues the remembered conversation without creating a new one', async () => {
    // 原来的这一条传的是 `sessionScope: 'pinned'` + `pinnedSessionId`，也就是那个
    // 手选 id 的机制。它已经并入「上次浏览器对话」，而"上次那段"记在扩展存储里
    //（`FRESH_SESSION_KEY`），所以这里改成从存储里给。要证的东西没变：就在已经存在的
    // 上下文里问某个页面，而不是从零开始。
    const { control, socket } = await boot({ sessionScope: 'last' }, { openPagesForUser: true }, {
      dshFreshSessionId: 'session-chosen',
    })
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'look at this' })

    // 存的 id 在发出去之前会先向桌面核对一次。
    const list = await waitForRpc(socket, 'session.list')
    answerRpc(socket, list, {
      ok: true,
      value: { items: [{ sessionId: 'session-chosen', title: '', updatedAt: 5_000, running: false }] },
    })

    const prompted = await waitForRpc(socket, 'session.prompt')
    expect(prompted.payload!.sessionId).toBe('session-chosen')
    // 没有创建新会话：目标是记住的那段，不是凭空冒出来的。
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(0)
    // 结算这次 prompt。留在途中的提交会比这个测试活得久，下一个测试会继承它半完成的
    // 状态，表现为两个测试之后一个看起来毫不相关的失败。
    answerRpc(socket, prompted, { ok: true, value: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session.result', id: 'p1', ok: true }),
      )
    })
  })

  it('lists the desktop conversations that are worth choosing, running first', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.list', id: 'l1' })
    const call = await waitForRpc(socket, 'session.list')
    answerRpc(socket, call, {
      ok: true,
      value: {
        // 桌面真正发出来的形态：标题在
        // `projections.values.title`，不在顶层，而子代理会带上
        // `origin` 和 parent 作标记。
        items: [
          {
            sessionId: 'old',
            updatedAt: 1_000,
            running: false,
            projections: { values: { title: 'older', turnOutline: [{ prompt: 'do the old thing', seq: 4 }] } },
          },
          {
            sessionId: 'new',
            updatedAt: 9_000,
            running: true,
            projections: { values: { title: 'newer', turnOutline: [{ prompt: '', seq: 1 }, { prompt: 'do the new thing', seq: 2 }] } },
          },
          // 被委派的子代理本身是一个 Session，但不是用户能在面板里
          // 接着用的对话：它每委派一次就出现一次，
          // 标题就是它自己的指令。
          {
            sessionId: 'sub',
            updatedAt: 8_000,
            running: false,
            origin: 'subagent',
            parentSessionId: 'new',
            projections: { values: { title: 'You are a senior code reviewer' } },
          },
          // 垃圾必须丢掉，既不渲染也不路由到。
          { sessionId: '', title: 'nameless', updatedAt: 5_000 },
          { title: 'no id at all', updatedAt: 5_000 },
          'not an object',
        ],
      },
    })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.list',
        id: 'l1',
        ok: true,
        // 先按运行中、再按最新排；`preview` 是第一个*非空* prompt，
        // 而标题来自 projection。
        sessions: [
          { sessionId: 'new', title: 'newer', preview: 'do the new thing', updatedAt: 9_000, running: true },
          { sessionId: 'old', title: 'older', preview: 'do the old thing', updatedAt: 1_000, running: false },
        ],
      })
    })
  })

  it('follows only the workspace conversations that are actually producing something', async () => {
    // 「工作区内」收敛到活跃的那个对话，而不是订阅工作区里的
    // 每个成员：二十个成员就意味着二十条服务端流，只为盯住
    // 那一两个真在工作的，而且群组会随着对话越攒越大。
    // `updatedAt` 只在某个对话有事件时才变，所以活跃度
    // 能从元数据直接答出来，不用去问任何 Session。
    //
    // 先启动它：worker 一加载就会碰 `chrome`，而本文件的桩是
    // `boot` 装的，被提升的静态 import 会跑到它前面。
    const { RECENT_ACTIVITY_MS, sessionsWorthFollowing } = await boot().then(() => (
      loadedWorker as unknown as {
        RECENT_ACTIVITY_MS: number
        sessionsWorthFollowing: (
          members: ReadonlySet<string>,
          active: readonly { sessionId: string; updatedAt: number; running: boolean }[],
          now: number,
        ) => string[]
      }
    ))
    // `elsewhere` 刻意不是成员：`session.list` 覆盖桌面上的每个对话，
    // 而这个模式只管群组自己的成员。
    const members = new Set(['live', 'recent', 'quiet'])
    const now = 1_000_000_000
    const at = (ageMs: number) => now - ageMs
    expect(sessionsWorthFollowing(
      members,
      [
        // 在途的一轮不管上次发事件是多久以前都保留：一轮很慢的回合不能
        // 半路被丢掉。
        { sessionId: 'live', updatedAt: at(RECENT_ACTIVITY_MS * 3), running: true },
        { sessionId: 'recent', updatedAt: at(RECENT_ACTIVITY_MS / 2), running: false },
        { sessionId: 'quiet', updatedAt: at(RECENT_ACTIVITY_MS * 2), running: false },
        // `session.list` 覆盖桌面上的每个对话；只有群组的
        // 成员才是这个模式的事。
        { sessionId: 'elsewhere', updatedAt: at(0), running: true },
      ],
      now,
    )).toEqual(['live', 'recent'])
    // 窗口边界算作仍活跃，所以边界上的东西不会被丢掉。
    expect(sessionsWorthFollowing(members, [{ sessionId: 'recent', updatedAt: at(RECENT_ACTIVITY_MS), running: false }], now))
      .toEqual(['recent'])
    expect(sessionsWorthFollowing(new Set(), [{ sessionId: 'live', updatedAt: at(0), running: true }], now)).toEqual([])
  })

  it('reports a list failure instead of showing an empty picker', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.list', id: 'l1' })
    const call = await waitForRpc(socket, 'session.list')
    answerRpc(socket, call, { ok: false, error: { code: 'internal', message: 'listing is unavailable' } })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'session.list',
        id: 'l1',
        ok: false,
        error: expect.stringContaining('unavailable'),
      }))
    })
  })

  it('mirrors every conversation in every workspace under 「全部工作区」', async () => {
    // 这个模式是为了让桌面上发出的指令不用事先挑选就能在这里出现。最早它只镜像 bridge
    // 给出的那个路径下的一个分组；现在按用户的要求放宽到**每一个**分组——"不管在 DSH 哪个
    // 工作区发对话，都同步到插件里"——所以下面那个 `w-other` 也必须出现。为此每个对话各开
    // 一个 follower：bridge 在没人请求之前不流任何东西。
    const { control, socket } = await boot({}, { openPagesForUser: true, sessionWorkspacePath: 'C:\\Users\\u\\.dsh\\browser-sessions' } as never)
    control.onMessage.emit({ type: 'session.select', id: 's1', scope: 'workspace', sessionId: null })
    const listed = await waitForRpc(socket, 'workspace.list')
    answerRpc(socket, listed, {
      ok: true,
      value: {
        items: [
          { workspaceId: 'w-other', path: 'C:\\elsewhere', title: 'other', sessionIds: ['session-other'] },
          { workspaceId: 'w-browser', path: 'C:\\Users\\u\\.dsh\\browser-sessions', title: '浏览器对话', sessionIds: ['session-a', 'session-b'] },
        ],
      },
    })
    // 每个对话一个 follower，跨所有分组。读的是 worker 实际发出的帧，不靠一次
    // `waitForRpc`：这几个请求会抢，而一个返回「第一个匹配帧」的辅助函数会把同一个帧报两遍。
    await waitFor(() => {
      expect(rpcFrames(socket, 'session.follow')).toHaveLength(3)
    })
    expect(rpcFrames(socket, 'session.follow').map((frame) => frame.payload?.sessionId).sort())
      .toEqual(['session-a', 'session-b', 'session-other'])
    // 这个模式会被记住，所以重连能恢复它，而不是默默地显示着
    // 这个设置却什么都没镜像。
    await waitFor(() => {
      expect(latestState(control.postMessage)?.settings.sessionScope).toBe('workspace')
    })
  })

  it('clears the transcript that belonged to the old conversation when the user switches to a new one', async () => {
    const { control, socket } = await boot()
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    const created = await waitForRpc(socket, 'session.create')
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    // 等绑定本身，不只是等某一行：只有真绑上会话之后，
    // 解绑才会清东西，所以断言早了
    // 不管清没清都会通过。
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.id).toBe(SESSION_ID)
    })
    // 一次工具调用，这样记录里就有一行明确不是面板
    // 自己的请求：清掉它才是下面断言要测的。
    socket.receive({ t: 'tool.call', id: 'call-1', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })
    await waitFor(() => {
      expect(timelineOf(control.postMessage).some((row) => row.kind === 'step')).toBe(true)
    })
    // 在切换之前先结算它。仍在途的调用会被刻意留着
    // 跨过一次切换，所以让它一直跑，这个测试就会断言出
    // 和它要讲的规则相反的结果。
    socket.receive({ t: 'tool.cancel', id: 'call-1' })
    await waitFor(() => {
      expect(timelineOf(control.postMessage).some((row) => row.kind === 'step' && row.state === 'cancelled')).toBe(true)
    })

    // 这一条原先切的是 `pinned` + `session-other`：切过去就立刻换绑定。那个手选机制
    // 已经删掉了，而 `last` 刻意**不立刻绑**——绑定是下一条消息的事（用户可能只是想改
    // 设置）。所以"解绑并清记录"现在要由 `fresh` 来证：切换必须丢掉旧对话的行。
    control.onMessage.emit({ type: 'session.select', id: 'sel1', scope: 'fresh', sessionId: null })
    // 显式请求状态，不去读 mock 的历史：这次
    // 写入是排队的，所以更早的推送可能先于设置变更落盘。
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const latest = latestState(control.postMessage)
      expect(latest?.settings.sessionScope).toBe('fresh')
    })
    const state = latestState(control.postMessage)!
    expect(state.session.id).toBeNull()
    expect(state.timeline.filter((row) => row.kind === 'step')).toEqual([])
  })

  it('ignores a session create that lands after the user switched away', async () => {
    // 竞争就在这儿：一次 prompt 正在 `session.create`，而用户在回复到达前换了目标。
    // 采纳那个回复，面板就会被悄悄拖回用户刚离开的那段对话。
    //
    // 这一条原先用 `scope: 'pinned'` + `sessionId` 表达"切到别处"。那个手选机制已经
    // 删掉，所以换目标改由 `last` 表达。
    const { control, socket } = await boot({ sessionScope: 'last' }, { openPagesForUser: true }, {
      dshFreshSessionId: 'session-chosen',
    })
    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    // 第一次 prompt 会先核对记住的那段（`session.list`），核对不通过才新建；这里要的
    // 就是那次 create 还在路上。注意这份测试替身的 `storage.local.get` 是固定返回值，
    // `remove()` 不会真的让它少给一个键，所以这一步必须显式答复。
    const probe = await waitForRpc(socket, 'session.list')
    answerRpc(socket, probe, { ok: true, value: { items: [] } })
    const created = await waitForRpc(socket, 'session.create')

    // 用户换到"上次浏览器对话"，这会作废那次还在路上的 create。
    control.onMessage.emit({ type: 'session.select', id: 'sel1', scope: 'last', sessionId: null })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 'sel1', ok: true })
    })

    // 现在那个过期的 create 才回话。
    answerRpc(socket, created, { ok: true, value: { sessionId: 'session-late' } })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      // 过期的 create 没能把面板绑到 `session-late` 上。
      expect(latestState(control.postMessage)?.session.id).not.toBe('session-late')
    })
  })

  it('goes back to creating its own session when the user switches to fresh', async () => {
    const { control, socket } = await boot({ sessionScope: 'last' }, { openPagesForUser: true }, {
      dshFreshSessionId: 'session-chosen',
    })
    control.onMessage.emit({ type: 'session.select', id: 'sel1', scope: 'fresh', sessionId: null })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({ type: 'session.result', id: 'sel1', ok: true })
    })
    expect(latestState(control.postMessage)?.session.id).toBeNull()

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })
    // `fresh` 清掉了记住的那段，但这份测试替身里 `storage.local.remove` 不会真的让
    // `get` 少给一个键（`localGet` 是固定返回值），所以恢复那条路还会读到它。让流程
    // 走完：核对用的 `session.list` 必须回空，`fresh` 这才是真的从头开始。
    const list = await waitForRpc(socket, 'session.list')
    answerRpc(socket, list, { ok: true, value: { items: [] } })

    // 它必须新建，而不是继续写进它刚离开的那个对话。
    const created = await waitForRpc(socket, 'session.create')
    expect(created.payload).toEqual({})
    answerRpc(socket, created, { ok: true, value: { sessionId: SESSION_ID } })
    await waitFor(() => {
      expect(latestState(control.postMessage)?.session.id).toBe(SESSION_ID)
    })
  })

  it('continues the remembered conversation after the worker has been recycled', async () => {
    // worker 会随侧边面板关闭而死，所以它在内存里的绑定已经
    // 没了。没有记住的 id，下一条消息就会开另一个
    // 对话，用户的浏览器历史就碎成每个空闲超时一段
    // 会话——每一段都得他们自己去找。
    const { control, socket } = await boot({}, { openPagesForUser: true }, {
      dshFreshSessionId: 'session-earlier',
    })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello again' })

    // 存的 id 在信之前会先向桌面核对。
    const list = await waitForRpc(socket, 'session.list')
    answerRpc(socket, list, {
      ok: true,
      value: { items: [{ sessionId: 'session-earlier', title: '', updatedAt: 5_000, running: false }] },
    })

    const prompt = await waitForRpc(socket, 'session.prompt')
    expect(prompt.payload?.sessionId).toBe('session-earlier')
    expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(0)
    // 结算这次 prompt。留在途中的提交会比这个测试活得久，
    // 下一个测试会继承它半完成的状态，表现为两个测试之后
    // 一个看起来毫不相关的失败。
    answerRpc(socket, prompt, { ok: true, value: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session.result', id: 'p1', ok: true }),
      )
    })
  })

  it('starts a new conversation when the remembered one is gone from the desktop', async () => {
    // 存的 id 可能比它的会话活得久：用户可能已经把那个
    // 对话删了。采纳一个已死的 id，prompt 就发进虚空，
    // 还报一个用户没法处理的 gateway 错误。
    const { chromeMock, control, socket } = await boot({}, { openPagesForUser: true }, {
      dshFreshSessionId: 'session-deleted',
    })

    control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })

    const list = await waitForRpc(socket, 'session.list')
    answerRpc(socket, list, {
      ok: true,
      value: { items: [{ sessionId: 'session-other', title: '', updatedAt: 5_000, running: false }] },
    })

    await waitFor(() => {
      expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(1)
    })
    const create = sent(socket).find((frame) => frame.t === 'rpc' && frame.method === 'session.create')!
    answerRpc(socket, create, { ok: true, value: { sessionId: 'session-new' } })
    // 那个已死的 id 必须忘掉，否则之后每次 prompt 都要重做这次探测。
    await waitFor(() => {
      expect(chromeMock.storage.local.remove).toHaveBeenCalledWith('dshFreshSessionId')
    })
    // 结算这次 prompt，这样就不会有东西留在途中留给下一个测试。
    const prompt = await waitForRpc(socket, 'session.prompt')
    expect(prompt.payload?.sessionId).toBe('session-new')
    answerRpc(socket, prompt, { ok: true, value: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session.result', id: 'p1', ok: true }),
      )
    })
  })

  // 存储是和这个扩展的旧版本、以及任何往里面写的东西
  // 共用的，所以不能假定记住的值就是这段代码写下的
  // 那个字符串。这些情况都必须落到一个新
  // 对话，而不是在 prompt 路径里抛错，否则用户
  // 看到的会是失败，而不是回复。
  for (const [label, stored] of [
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { sessionId: 'session-earlier' }],
    ['null', null],
    ['an array', ['session-earlier']],
  ] as const) {
    it(`starts a new conversation when the remembered value is ${label}`, async () => {
      const { control, socket } = await boot({}, { openPagesForUser: true }, {
        dshFreshSessionId: stored,
      })

      control.onMessage.emit({ type: 'session.prompt', id: 'p1', text: 'hello' })

      await waitFor(() => {
        expect(sent(socket).filter((frame) => frame.t === 'rpc' && frame.method === 'session.create')).toHaveLength(1)
      })
      // 垃圾值根本不该拿去问桌面。
      expect(rpcFrame(socket, 'session.list')).toBeUndefined()

      const create = sent(socket).find((frame) => frame.t === 'rpc' && frame.method === 'session.create')!
      answerRpc(socket, create, { ok: true, value: { sessionId: 'session-fresh' } })
      const prompt = await waitForRpc(socket, 'session.prompt')
      expect(prompt.payload?.sessionId).toBe('session-fresh')
      answerRpc(socket, prompt, { ok: true, value: {} })
      await waitFor(() => {
        expect(control.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'session.result', id: 'p1', ok: true }),
        )
      })
    })
  }
})

describe('typed browser commands', () => {
  const runCommand = (control: ReturnType<typeof controlPort>, id: string, name: string, args: Record<string, unknown>) => {
    control.onMessage.emit({ type: 'command.run', id, name, args })
  }

  it('executes a typed command without an approval prompt and records it as a command', async () => {
    // 受限、页面共享为「ask」：模型快照在这里会弹提示。
    const { chromeMock, control } = await boot({ unrestrictedBrowserAccess: false, sharePageContent: 'ask' })
    runCommand(control, 'snap-1', 'browser_snapshot', {})
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'snap-1',
        ok: true,
        result: expect.objectContaining({ text: expect.any(String) }),
      })
    })

    runCommand(control, 'click-1', 'browser_click', { index: 3 })
    await waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'DSH_ACTION', action: 'browser_click', args: { index: 3 } }),
        expect.anything(),
      )
    })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'click-1',
        ok: true,
        result: expect.anything(),
      })
    })

    // 从没提供过审批，bridge 也完全没参与。
    expect(sentMessages(control.postMessage)).not.toContainEqual(expect.objectContaining({ type: 'approval.request' }))
    expect(rpcFrame(FakeWebSocket.instances[0]!, 'session.prompt')).toBeUndefined()

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.activity[0]).toMatchObject({ kind: 'command', name: 'browser_click', state: 'done' })
      const steps = state.timeline.filter((entry) => entry.kind === 'step')
      expect(steps).toHaveLength(2)
      expect(steps[1]).toMatchObject({ kind: 'step', tool: 'browser_click', state: 'done' })
      expect(steps[1]!.callId).toBe(state.activity[0]!.id)
    })
    // 手动敲的命令行被标成用户自己的，不是模型的。
    expect(activityRows(control.postMessage).some((row) => row.kind === 'command' && row.state === 'pending')).toBe(true)
  })

  it('refuses a command the worker has no tool for, without touching the page', async () => {
    const { chromeMock, control } = await boot({ unrestrictedBrowserAccess: true })
    runCommand(control, 'bad-1', 'browser_frobnicate', { index: 1 })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'bad-1',
        ok: false,
        error: expect.stringContaining('Unknown browser command "browser_frobnicate"'),
      })
    })
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled()

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      expect(state.timeline.filter((entry) => entry.kind === 'step'))
        .toEqual([expect.objectContaining({ tool: 'browser_frobnicate', state: 'failed' })])
      expect(state.activity[0]).toMatchObject({ kind: 'command', name: 'browser_frobnicate', state: 'failed' })
    })
  })

  it('refuses browser_close_tab without an explicit confirm argument, then honours it', async () => {
    const { chromeMock, control } = await boot({ unrestrictedBrowserAccess: true })
    runCommand(control, 'close-1', 'browser_close_tab', { tabId: 2 })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'close-1',
        ok: false,
        error: expect.stringContaining('"confirm": true'),
      })
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()

    runCommand(control, 'close-2', 'browser_close_tab', { tabId: 2, confirm: true })
    await waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(2) })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'close-2',
        ok: true,
        result: expect.anything(),
      })
    })
    expect(sentMessages(control.postMessage)).not.toContainEqual(expect.objectContaining({ type: 'approval.request' }))
  })

  it('records a model-driven call as a tool step that ends in done', async () => {
    // 页面共享为「ask」：这次读取要用户做决定，而这正是
    // 模型步骤和手动命令的分界。
    const { control, socket } = await boot({ unrestrictedBrowserAccess: false, sharePageContent: 'ask' })
    socket.receive({ t: 'tool.call', id: 'call-9', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 60_000 })

    const request = await waitFor(() => {
      const pending = approvalRequest(control.postMessage)
      expect(pending?.id).toBeTypeOf('string')
      return pending!
    })
    expect(request.action).toBe('browser_snapshot')

    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const step = timelineOf(control.postMessage).find((entry) => entry.callId === 'call-9')
      expect(step).toMatchObject({ kind: 'step', tool: 'browser_snapshot', state: 'running' })
      expect(activityRows(control.postMessage)).toContainEqual(expect.objectContaining({ id: 'call-9', kind: 'tool', state: 'running' }))
    })

    control.onMessage.emit({ type: 'approval.respond', id: request.id, decision: 'allow-once' })
    await waitFor(() => {
      expect(sent(socket)).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-9', ok: true }))
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const step = timelineOf(control.postMessage).find((entry) => entry.callId === 'call-9')
      expect(step?.state).toBe('done')
      expect(activityRows(control.postMessage)).toContainEqual(expect.objectContaining({ id: 'call-9', kind: 'tool', state: 'done' }))
    })
  })

  it('runs a typed command with no bridge at all', async () => {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: {} }) })
    // 扩展总是会拨号；没人应答才是它停下来的原因。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const control = controlPort()
    chromeMock.onConnect.emit(control.port)
    await waitFor(() => { expect(latestState(control.postMessage)?.bridge).toBe('stopped') })

    control.onMessage.emit({ type: 'command.run', id: 'snap-offline', name: 'browser_snapshot', args: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'snap-offline',
        ok: true,
        result: expect.anything(),
      })
    })
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('adds only a command step for a typed command, never a model step', async () => {
    const { control } = await boot({ unrestrictedBrowserAccess: true })
    control.onMessage.emit({ type: 'command.run', id: 'snap-1', name: 'browser_snapshot', args: {} })
    await waitFor(() => {
      expect(control.postMessage).toHaveBeenCalledWith({
        type: 'session.result',
        id: 'snap-1',
        ok: true,
        result: expect.anything(),
      })
    })
    control.onMessage.emit({ type: 'state.request' })
    await waitFor(() => {
      const state = latestState(control.postMessage)!
      // 时间线步骤和活动行一致，两处都说「是你问的」。
      const step = state.timeline.find((entry) => entry.kind === 'step')
      expect(step).toMatchObject({ tool: 'browser_snapshot', state: 'done' })
      expect(state.activity.find((entry) => entry.id === step?.callId)).toMatchObject({ kind: 'command', state: 'done' })
    })
  })
})
