/**
 * 侧边面板：与 dsh 的一段对话，外加一张设置表。
 *
 * 这里刻意沿用桌面客户端的形态。整个界面就是这份记录——你的消息、模型
 * 渲染成 Markdown 的回复，以及每次工具调用各占一行安静说明。唯一多出来的
 * 东西，是给多步回合准备的 **任务清单**：模型先写下要做的事，面板把它连同
 * 每个任务的状态摆在这次运行上方，因为光看工具调用列表，说不清这活儿是什么、
 * 还剩多少。这里依然没有摘要卡片、没有进度条，也没有插图。
 *
 * 输入框同时管着两种输入：
 *   - 浏览器命令（`browser_click {"index":3}`、`click index=3`、一个 URL）由扩展
 *     自己执行，因为这是用户亲手敲的；
 *   - 其他任何内容都转发给桌面端的 dsh 模型，流式回复在这里渲染。
 *
 * 本页面不掌握任何策略：审批、标签页绑定、不受限开关都在后台 worker 里，
 * 这个文件只负责把交给它的内容渲染出来。
 *
 * @module
 */

import {
  CONTROL_PORT_NAME,
  SETTINGS_DEFAULTS,
  normalizeSettings,
  type ActivityEntry,
  type ControlMessage,
  type ControlRequest,
  type ControlState,
  type Settings,
  type TimelineEntry,
} from '../src/settings.ts'
import type { ApprovalDecision, ApprovalRequest } from '../src/security/approval.ts'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'
import { getUiLocale, type UiLocale } from '../src/i18n.ts'
import { classifyInput, isSoftOpenError, type InputIntent } from './command.ts'
import { hasMarkdownContent, renderMarkdown } from './markdown.ts'
import { icon, markerIcon, type IconName } from './icons.ts'
import { controlCopy, describeOpenError, type ControlCopy } from './strings.ts'
import { parsePlan, planProgress, type Plan } from '@dsh-browser/protocol'

/** 页面报告 worker 已消失之前，等多久才重连。 */
export const RECONNECT_DELAY_MS = 250

/** 只有旧的 activity 列表可用时，留多少行。 */
export const ACTIVITY_LIMIT = 200

/* ------------------------------------------------------------------ *
 * 纯函数辅助
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 一个滚动容器要离底端多近，才算"跟在尾部"。
 *
 * 两条路径共用一个阈值：流式重绘和整体重绘对"在底部"得有一致的判断，否则读者
 * 明明快到底了，会被一条路径挪走、又被另一条留在原地。
 */
function atBottom(scroller: Element): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
}

/** bridge 某种连接状态对应的状态词。 */
export function bridgeStateText(state: ControlState['bridge'], copy: ControlCopy): string {
  return copy.bridge[state] ?? copy.bridge.stopped
}

/** 一行文字，说明这个 worker 控制的是什么。 */
export function controlledTabText(affinity: TabAffinityState, copy: ControlCopy): string {
  const tab = affinity.controlled
  if (tab === null) return copy.tab.none
  const title = tab.title.trim() === '' ? tab.url : tab.title
  return title === '' ? copy.tab.none : title
}

/** 一次审批可选的决定，按显示顺序排。 */
export function approvalDecisions(request: ApprovalRequest): ApprovalDecision[] {
  const decisions: ApprovalDecision[] = ['deny', 'allow-once']
  if (request.kind !== 'action') decisions.push('always-allow-reads')
  if (request.kind === 'action' && request.canTrust && request.origins.length === 1) decisions.push('trust-session')
  return decisions
}

/** 把一条 activity 推送并进列表：最新的在前，按 id 去重。 */
export function mergeActivity(existing: ActivityEntry[], entry: ActivityEntry, limit = ACTIVITY_LIMIT): ActivityEntry[] {
  const merged = [entry, ...existing.filter((candidate) => candidate.id !== entry.id)]
  return merged.slice(0, Math.max(0, limit))
}

/** 把审批快照或实时推送并起来，按请求 id 做键。 */
export function mergeApprovals(
  current: ReadonlyMap<string, ApprovalRequest>,
  incoming: readonly ApprovalRequest[],
  options: { full?: boolean; answered?: ReadonlySet<string> } = {},
): Map<string, ApprovalRequest> {
  const next = new Map<string, ApprovalRequest>(options.full === true ? [] : current)
  for (const request of incoming) {
    if (options.answered?.has(request.id) === true) continue
    next.set(request.id, request)
  }
  return next
}

/** 从 dsh 的 content-block 数组里取出纯文本。 */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * 一个 `session/event` 里带的 assistant 文本。
 *
 * 会调用工具的回合还会发 `assistant/message` 事件，里面只有 `tool_use`
 * block；这类事件不能把回复清空，所以结果全空时返回 `undefined`，而不是空字符串。
 */
export function assistantTextFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== 'assistant/message') return undefined
  const data = isRecord(event.data) ? event.data : undefined
  const message = data !== undefined && isRecord(data.message) ? data.message : undefined
  const text = textFromBlocks(message?.content ?? data?.content)
  return text.trim() === '' ? undefined : text
}

/** 判断一个 `user/message` 事件是真回合，还是注入的提醒。 */
export function isUserAuthoredMessage(event: unknown): boolean {
  if (!isRecord(event) || event.type !== 'user/message') return false
  const data = isRecord(event.data) ? event.data : undefined
  const message = data !== undefined && isRecord(data.message) ? data.message : data
  const source = message !== undefined && isRecord(message.source) ? message.source : undefined
  return source?.kind === 'user'
}

/** 某个工具名对应的可读标签。 */
export function toolLabel(tool: string | undefined, copy: ControlCopy): string {
  if (tool === undefined || tool === '') return copy.timeline.tool
  const bare = tool.startsWith('browser_') ? tool.slice('browser_'.length) : tool
  return bare.replace(/_/g, ' ')
}

/** 步骤状态的白话说法，只用在工具行的 title 上。 */
export function stateText(state: TimelineEntry['state'], locale: UiLocale): string {
  const zh = locale === 'zh'
  switch (state) {
    case 'done': return zh ? '已完成' : 'Done'
    case 'failed': return zh ? '失败' : 'Failed'
    case 'denied': return zh ? '已拒绝' : 'Denied'
    case 'cancelled': return zh ? '已取消' : 'Cancelled'
    case 'running': return zh ? '进行中' : 'Running'
    default: return zh ? '等待中' : 'Pending'
  }
}

/** 记录里的每一行，最早的排在最前。 */
export function timelineFromState(state: ControlState): TimelineEntry[] {
  if (state.timeline.length > 0) return state.timeline
  return state.activity.slice().reverse().map((entry) => ({
    id: entry.id,
    kind: 'step' as const,
    text: entry.summary,
    tool: entry.name,
    state: entry.state,
    at: entry.at,
    callId: entry.id,
  }))
}

/* ------------------------------------------------------------------ *
 * DOM 构建
 * ------------------------------------------------------------------ */

interface ElementOptions {
  className?: string
  text?: string
  attributes?: Record<string, string>
  children?: (Node | null | undefined)[]
  on?: Record<string, (event: Event) => void>
}

/**
 * 构建一个元素。
 *
 * `text` 一律走 `textContent`。整个文件里给 HTML 赋值的只有 assistant 气泡，
 * 那条路径会先用 DOMPurify 消毒。
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElementOptions = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.className !== undefined) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  for (const [name, value] of Object.entries(options.attributes ?? {})) node.setAttribute(name, value)
  for (const [event, handler] of Object.entries(options.on ?? {})) node.addEventListener(event, handler)
  for (const child of options.children ?? []) {
    if (child !== null && child !== undefined) node.append(child)
  }
  return node
}

function iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  return el('button', {
    className: 'btn btn--icon',
    attributes: { type: 'button', title: label, 'aria-label': label },
    on: { click: onClick },
    children: [icon(name, 16)],
  })
}

/* ------------------------------------------------------------------ *
 * Port 客户端
 * ------------------------------------------------------------------ */

interface PendingCall {
  resolve: (value: { sessionId?: string }) => void
  reject: (error: Error) => void
  /**
   * 防止 worker 永远不回话。
   *
   * 以前一个被丢掉的 `session.result` 会让 promise 一直 pending，等它的人也就
   * 一直等下去：选择器卡在"loading"，发送按钮卡在 disabled。让调用方能处理的
   * rejection，总好过一个永不 settle 的 promise。
   */
  timer: ReturnType<typeof setTimeout>
}

/** 一次 `session.*` 请求多久没回应就算失败。 */
export const CALL_TIMEOUT_MS = 15_000

/** `dsh-control` 通道的 Port 客户端，带一次重连尝试。 */
export class ControlPort {
  private port: chrome.runtime.Port | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private readonly pending = new Map<string, PendingCall>()

  constructor(
    private readonly onMessage: (message: ControlMessage) => void,
    private readonly onStatusChange: (connected: boolean) => void,
  ) {}

  get connected(): boolean {
    return this.port !== null
  }

  /** 打开端口；断连不是我们自己造成时，重试一次。 */
  connect(allowRetry = true): void {
    if (this.port !== null) return
    if (typeof chrome === 'undefined' || chrome.runtime?.connect === undefined) {
      this.onStatusChange(false)
      return
    }
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: CONTROL_PORT_NAME })
    } catch {
      this.onStatusChange(false)
      return
    }
    this.port = port
    this.onStatusChange(true)
    port.onMessage.addListener((message: unknown) => this.deliver(message))
    // worker 如果在这页面打开前刚醒来，它的推送已经发过了。
    this.post({ type: 'state.request' })
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return
      this.port = null
      this.failAll(new Error('background disconnected'))
      this.onStatusChange(false)
      if (!allowRetry) return
      this.retry = setTimeout(() => {
        this.retry = null
        if (this.port === null) this.connect(false)
      }, RECONNECT_DELAY_MS)
    })
  }

  /** 发一条控制请求；端口已死就报失败，不抛异常。 */
  post(message: ControlRequest): boolean {
    const port = this.port
    if (port === null) return false
    try {
      port.postMessage(message)
      return true
    } catch {
      this.port = null
      this.failAll(new Error('background disconnected'))
      this.onStatusChange(false)
      return false
    }
  }

  /** 发一条以 `session.result` 帧作答的请求。 */
  call(message: ControlRequest): Promise<{ sessionId?: string }> {
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      if (!this.post({ ...message, id } as ControlRequest)) {
        reject(new Error('background disconnected'))
        return
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error('no answer from the background'))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  dispose(): void {
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    const port = this.port
    this.port = null
    // 把在飞的东西全部结清。让它们一直 pending，调用方就可能永远等一个
    // 不会来的回答——面板正在消失。
    this.failAll(new Error('panel closed'))
    try {
      port?.disconnect()
    } catch {
      // 早就没了。
    }
  }

  private failAll(error: Error): void {
    for (const [id, call] of this.pending) {
      this.pending.delete(id)
      clearTimeout(call.timer)
      call.reject(error)
    }
  }

  private deliver(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== 'string') return
    switch (raw.type) {
      case 'state': {
        const state = parseControlState(raw.state)
        if (state !== null) this.onMessage({ type: 'state', state })
        return
      }
      case 'activity': {
        const entry = parseActivity(raw.entry)
        if (entry !== null) this.onMessage({ type: 'activity', entry })
        return
      }
      case 'approval.request': {
        const request = parseApproval(raw.request)
        if (request !== null) this.onMessage({ type: 'approval.request', request })
        return
      }
      case 'session.stream':
        this.onMessage({ type: 'session.stream', event: raw.event as never })
        return
      case 'session.event':
        this.onMessage({ type: 'session.event', sessionId: String(raw.sessionId ?? ''), event: raw.event })
        return
      case 'session.result': {
        if (typeof raw.id !== 'string') return
        const call = this.pending.get(raw.id)
        if (call === undefined) return
        this.pending.delete(raw.id)
        clearTimeout(call.timer)
        if (raw.ok === true) call.resolve({ ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}) })
        else call.reject(new Error(typeof raw.error === 'string' ? raw.error : 'request failed'))
        return
      }
      case 'settings.result':
      case 'affinity.rebind.result': {
        if (typeof raw.id !== 'string') return
        if (raw.ok === true) this.onMessage({ type: raw.type, id: raw.id, ok: true })
        else this.onMessage({ type: raw.type, id: raw.id, ok: false, error: String(raw.error ?? 'unknown') })
        return
      }
      default:
        return
    }
  }
}

/* ------------------------------------------------------------------ *
 * 载荷校验
 * ------------------------------------------------------------------ */

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseAffinityTab(value: unknown): TabAffinityState['controlled'] {
  if (!isRecord(value) || typeof value.tabId !== 'number' || typeof value.windowId !== 'number') return null
  return {
    tabId: value.tabId,
    windowId: value.windowId,
    title: stringOr(value.title, ''),
    url: stringOr(value.url, ''),
  }
}

const AFFINITY_STATUSES: readonly TabAffinityState['status'][] = ['unbound', 'following', 'handoff', 'background', 'lost']
const BRIDGE_STATES: readonly ControlState['bridge'][] = ['connecting', 'connected', 'reconnecting', 'stopped']
const ENTRY_STATES: readonly TimelineEntry['state'][] = ['pending', 'running', 'done', 'failed', 'denied', 'cancelled']
const ENTRY_KINDS: readonly TimelineEntry['kind'][] = ['request', 'assistant', 'step']

function parseTimelineEntry(value: unknown): TimelineEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  return {
    id: value.id,
    kind: ENTRY_KINDS.find((kind) => kind === value.kind) ?? 'step',
    text: stringOr(value.text, ''),
    ...(typeof value.tool === 'string' ? { tool: value.tool } : {}),
    state: ENTRY_STATES.find((state) => state === value.state) ?? 'pending',
    at: numberOr(value.at, Date.now()),
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
  }
}

function parseActivity(value: unknown): ActivityEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  return {
    id: value.id,
    name: stringOr(value.name, ''),
    summary: stringOr(value.summary, ''),
    kind: value.kind === 'command' ? 'command' : 'tool',
    origin: typeof value.origin === 'string' ? value.origin : null,
    state: ENTRY_STATES.find((state) => state === value.state) ?? 'running',
    at: numberOr(value.at, Date.now()),
  }
}

function parseApproval(value: unknown): ApprovalRequest | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null
  const request: ApprovalRequest = {
    id: value.id,
    kind: value.kind === 'action' ? 'action' : 'read',
    action: stringOr(value.action, ''),
    summary: stringOr(value.summary, ''),
    origins: Array.isArray(value.origins)
      ? value.origins.filter((origin): origin is string => typeof origin === 'string')
      : [],
    canTrust: value.canTrust === true,
  }
  if (typeof value.sessionId === 'string') request.sessionId = value.sessionId
  return request
}

function parseControlState(value: unknown): ControlState | null {
  if (!isRecord(value)) return null
  const session = isRecord(value.session) ? value.session : {}
  const affinity = isRecord(value.affinity) ? value.affinity : {}
  const caps = isRecord(value.caps) ? value.caps : null
  return {
    enabled: value.enabled !== false,
    bridge: BRIDGE_STATES.find((state) => state === value.bridge) ?? 'stopped',
    caps: caps === null
      ? null
      : {
          snapshotMaxChars: numberOr(caps.snapshotMaxChars, 0),
          maxInteractiveItems: numberOr(caps.maxInteractiveItems, 0),
        },
    affinity: {
      revision: numberOr(affinity.revision, 0),
      status: AFFINITY_STATUSES.find((status) => status === affinity.status) ?? 'unbound',
      controlled: parseAffinityTab(affinity.controlled),
      active: parseAffinityTab(affinity.active),
      pinned: affinity.pinned === true,
    },
    approvals: Array.isArray(value.approvals)
      ? value.approvals.map(parseApproval).filter((entry): entry is ApprovalRequest => entry !== null)
      : [],
    settings: normalizeSettings(isRecord(value.settings) ? value.settings as Partial<Settings> : undefined),
    sessionTrustedOrigins: Array.isArray(value.sessionTrustedOrigins)
      ? value.sessionTrustedOrigins.filter((origin): origin is string => typeof origin === 'string')
      : [],
    activity: Array.isArray(value.activity)
      ? value.activity.map(parseActivity).filter((entry): entry is ActivityEntry => entry !== null)
      : [],
    session: {
      id: typeof session.id === 'string' ? session.id : null,
      turn: session.turn === 'running' ? 'running' : 'idle',
      pendingPrompt: session.pendingPrompt === true,
    },
    timeline: Array.isArray(value.timeline)
      ? value.timeline.map(parseTimelineEntry).filter((entry): entry is TimelineEntry => entry !== null)
      : [],
    // 缺失或格式不对都当作 null，面板会显示成"不允许"：
    // 一份读不出来的策略，绝不能看起来像许可。
    policy: isRecord(value.policy) && typeof value.policy.openPagesForUser === 'boolean'
      ? { openPagesForUser: value.policy.openPagesForUser }
      : null,
    replaced: value.replaced === true,
    // 拒绝原因只用面板自己的一句话说，不把服务器的原始字符串摊给用户看；这里只判断
    // "有没有被拒绝过"。形状不对就当没有，免得一次坏推送在面板上留一条假警告。
    bridgeRejection: isRecord(value.bridgeRejection) && typeof value.bridgeRejection.code === 'number'
      ? { code: value.bridgeRejection.code, reason: typeof value.bridgeRejection.reason === 'string' ? value.bridgeRejection.reason : '' }
      : null,
    // 是字符串就留下，什么都没有也算；其他任何东西一律当作没有错误，这样一次
    // 格式错误的推送就没法把半句话摆到用户面前。
    followError: typeof value.followError === 'string' && value.followError !== '' ? value.followError : null,
  }
}

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */

interface RunState {
  /** 模型为当前回合已经写出的文本。 */
  assistantText: string
  /**
   * 本回合宣布过的清单，只要它宣布过。
   *
   * 模型推进时会重发带勾选框的清单，所以这里存的是见过的
   * 最完整那版，而不是最新那版：否则一个流式片段就会把已完成的清单
   * 盖成残缺的一份。
   */
  plan: Plan | null
}

/**
 * 同一份清单的两个版本，留更完整的那个。
 *
 * 模型先写一遍清单，再带着勾选框写一遍。第二份在流式传输的过程中
 * 起初比第一份 *更短*，所以"最新者胜"会在每次更新时明显地把清单截断。
 * 更长的那份就是同一个计划；只有当两者一样长时，更新的那份才算数，
 * 因为那时候方框才带上了进度。
 */
export function preferPlan(current: Plan | null, candidate: Plan | null): Plan | null {
  if (candidate === null) return current
  if (current === null) return candidate
  if (current.tasks.length !== candidate.tasks.length) {
    return candidate.tasks.length > current.tasks.length ? candidate : current
  }
  const progress = planProgress(candidate)
  const before = planProgress(current)
  return progress.done + progress.failed >= before.done + before.failed ? candidate : current
}

function emptyAffinity(): TabAffinityState {
  return { revision: 0, status: 'unbound', controlled: null, active: null, pinned: false }
}

export class App {
  private state: ControlState | null = null
  private readonly approvals = new Map<string, ApprovalRequest>()
  private readonly answered = new Set<string>()
  private readonly expanded = new Set<string>()
  private activity: ActivityEntry[] = []
  private run: RunState = { assistantText: '', plan: null }
  /**
   * 这一帧有没有排上一次流式重绘。
   *
   * 一条回复每秒可能来几百个 delta，每次重绘都要渲染整段已累积文本（Markdown 解析 +
   * 消毒 + innerHTML）。每个 delta 都这么干，工作量就随回复长度二次增长，面板
   * 永远落在后面——再也追不上，所以它看起来像卡死，而不是像变慢。合并成
   * 每帧一次，开销就跟回复长度保持线性。
   */
  private streamRepaintQueued = false
  /**
   * 设置表上次是照什么画出来的，好让一次 state 推送能跳过重建。
   *
   * 只放这张表真正会读的字段——见 `refreshSettingsSheet`。
   */
  private settingsFingerprint: string | null = null
  /**
   * 这条实时回复属于哪段会话。
   *
   * `run.assistantText` 说的是某段会话正在飞的回复，所以面板一转向别的会话，
   * 它就必须被丢掉。不这么做，你离开的那段会话写到一半的答案会继续渲染在你切过去的
   * 那段会话里——还带着闪烁的光标，好像它还在不断到达。
   */
  private runSessionId: string | null = null
  private backgroundDown = false
  private notice: string | null = null
  private composerError: string | null = null
  private settingsOpen = false
  private draft = ''
  private busy = false
  /**
   * 下一次整体重绘之后要恢复的记录滚动位置。
   *
   * `render()` 会换掉整棵树，滚动器随之被销毁、位置回到顶部，所以位置要在重建前
   * 捕获、重建后再套回去。这里原来是一个 `pinnedScroll = true` 标志，却没有任何东西
   * 清过它，于是每次整体重绘都把读者拽到底部——包括他们在翻历史时
   * 由一次连接更新触发的那次重绘。
   *
   * `null` 表示"在底部"，起始状态也正是它。
   */
  private restoreScroll: number | null = null
  /**
   * 面板尺寸变化时重新钳制阅读宽度上限。
   *
   * 这个上限只是最大列宽，所以得跟着面板走：套着很宽的上限把侧边面板拖窄，
   * 内容就会被排到边界之外，于是看不见——原因就在这里。
   */
  private widthObserver: ResizeObserver | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly locale: UiLocale,
    private readonly port: ControlPort,
    private readonly copy: ControlCopy,
  ) {}

  start(): void {
    document.title = this.copy.documentTitle
    document.documentElement.lang = this.locale
    // 第一次绘制之前就先套上这个上限。它原来只在一次 `state` 推送到达时才套，于是面板
    // 带着样式表的默认上限（640px）打开，一直停在那儿等 worker 作答——worker 要是从不
    // 作答，就永远停着。在一个 360px 的面板里，那意味着内容被排得比面板还宽，也就是那个
    // 空白面板 bug。
    this.applyReadWidth()
    this.render()
    this.port.connect()
    // 侧边面板是用户拖出来的，所以它一变，这个上限就得重新套一遍。
    if (typeof ResizeObserver !== 'undefined') {
      this.widthObserver = new ResizeObserver(() => { this.applyReadWidth() })
      this.widthObserver.observe(this.root)
    }
  }

  /**
   * 套上阅读宽度上限。
   *
   * 面板多宽是浏览器的事——用户拖，浏览器记——所以这里只管一个文本列最宽
   * 能到多少。更窄的面板永远按全宽用。
   */
  private applyReadWidth(): void {
    const width = this.state?.settings.readWidth ?? SETTINGS_DEFAULTS.readWidth
    // 这个上限必须钳到面板宽度，不能直接写进去。
    //
    // 这个值只是*最大*阅读宽度，而面板宽度是用户拖出来的。在一个 360px 的面板里把
    // `--panel-max` 设成 640，每个文本列就在 360px 的盒子里宽达 640px；内容排到
    // 右边界之外，被记录的 `overflow-x: hidden` 裁掉——这就是"面板是空白的"最后
    // 查出来的原因。下面的注释一直说更窄的面板优先——现在代码也这么做了。
    // 还没完成布局的面板会报 0。这时候回退到原始配置的上限，就把这个钳制正要
    // 躲开的溢出又造了出来：一个隐藏的面板拿到 `--panel-max: 640px`，一露头就把内容画得
    // 比自身更宽。
    const measured = this.root.clientWidth
    const available = measured > 0 ? measured : Math.min(width, SETTINGS_DEFAULTS.readWidth)
    document.documentElement.style.setProperty('--panel-max', `${Math.min(width, available)}px`)
  }

  dispose(): void {
    this.widthObserver?.disconnect()
    this.widthObserver = null
    this.port.dispose()
  }

  /* ---- messages ---- */

  handleMessage(message: ControlMessage): void {
    switch (message.type) {
      case 'state': {
        const parsed = parseControlState(message.state)
        if (parsed === null) return
        this.state = parsed
        this.backgroundDown = false
        // 会话一换，上一段会话正在飞的回复就不归我们了。
        const sessionId = parsed.session.id
        if (sessionId !== this.runSessionId) {
          this.runSessionId = sessionId
          this.run = { assistantText: '', plan: null }
        }
        const snapshot = mergeApprovals(this.approvals, parsed.approvals, { full: true, answered: this.answered })
        this.approvals.clear()
        for (const [id, request] of snapshot) this.approvals.set(id, request)
        for (const id of this.answered) {
          if (!this.approvals.has(id)) this.answered.delete(id)
        }
        this.activity = parsed.activity.slice(0, ACTIVITY_LIMIT)
        if (parsed.session.turn === 'idle' && !parsed.session.pendingPrompt) this.busy = false
        this.applyReadWidth()
        // 只重绘这次 state 能改的东西，而不是整个面板。整体重建会把输入框一起换掉，可输入框
        // 握着读者的焦点和他们打了一半的消息：回复流式到达时每 50 ms 就推一次 state，
        // 重建它等于把一个回合里敲的每个键都扔掉。下面这两块都很便宜，也都不碰输入框
        // 和设置表。
        this.replaceHeader()
        this.renderTranscript()
        this.refreshSettingsSheet()
        // 回合标志也随 `state` 一起到，它一翻转，发送按钮就得变成停止按钮（或者变回来）。
        // 少了这一步，按钮会一直保持上一个回合的样子，直到别的什么事件碰巧把它刷新。
        this.refreshComposerAction()
        return
      }
      case 'activity':
        this.activity = mergeActivity(this.activity, message.entry)
        this.renderTranscript()
        return
      case 'approval.request': {
        if (this.answered.has(message.request.id)) return
        this.approvals.set(message.request.id, message.request)
        this.renderTranscript()
        return
      }
      case 'session.stream':
        this.applyStream(message.event)
        return
      case 'session.event':
        this.applySessionEvent(message.sessionId, message.event)
        return
      // 这两个都在回应读者发出的请求，所以落地时读者可能正在打字——设置变更回一个
      // 结果，重新绑定给一个答复。它们改的只是提示或输入框错误，所以都不需要那个
      // 过去会换掉 textarea 的整体重建。
      case 'settings.result':
        this.notice = message.ok ? null : message.error
        this.refreshForTurn()
        return
      case 'affinity.rebind.result':
        if (!message.ok) this.notice = `${this.copy.tab.bindFailed}: ${message.error}`
        this.refreshForTurn()
        return
    }
  }

  private applyStream(raw: unknown): void {
    if (!isRecord(raw)) return
    // 面板只渲染一条实时回复——一个 `run.assistantText`、一个流式气泡——所以它只认
    // 自己这段会话的 delta。在「工作区内」模式下，worker 也会转发镜像过来的会话（打上
    // `attributeTo` 标记），它们的行照样走 `state.timeline` 进来；这里只跳过它们的
    // *实时文本*，因为一段会话写到一半的回复没有地方放。
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
    const active = this.state?.session.id ?? null
    if (active !== null && sessionId !== active) return
    const payload = raw.payload
    if (raw.kind === 'snapshot') {
      const record = isRecord(payload) ? payload : {}
      const baseline = isRecord(record.frame) ? record.frame.baseline : undefined
      const text = baseline === undefined ? undefined : textFromBlocks(baseline)
      if (text !== undefined && text !== '') this.run.assistantText = text
      this.renderStreaming()
      return
    }
    const frame = isRecord(payload) ? payload : {}
    if (frame.type === 'start') {
      this.run.assistantText = ''
      this.renderStreaming()
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = isRecord(frame.chunk) ? frame.chunk : undefined
    if (chunk === undefined) return
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      this.run.assistantText += chunk.text
      this.renderStreaming()
    }
  }

  private applySessionEvent(sessionId: string, event: unknown): void {
    // 回合标志只属于面板自己这段会话。镜像过来的会话也会送来回合事件（「工作区内」），
    // 在这儿套用它们，面板就会声称有回合在跑——还把发送按钮换成停止按钮——只因
    // 为别的会话起了一个回合。它的行照样通过 `state.timeline` 进记录。
    const active = this.state?.session.id ?? null
    if (active !== null && sessionId !== active) return
    if (!isRecord(event)) return
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'turn/start') {
      this.setSession({ turn: 'running', pendingPrompt: false })
      this.run = { assistantText: '', plan: null }
      this.refreshForTurn()
      return
    }
    if (type === 'turn/end') {
      this.setSession({ turn: 'idle', pendingPrompt: false })
      this.busy = false
      this.refreshForTurn()
      return
    }
    const text = assistantTextFromEvent(event)
    if (text !== undefined) {
      this.run.assistantText = text
      // 本回合的清单，前提是模型宣布过一份。它和气泡渲染的是同一段文本，
      // 所以用户读到的和清单显示的永远不会打架。
      this.run.plan = preferPlan(this.run.plan, parsePlan(text))
      this.renderStreaming()
    }
  }

  private setSession(patch: Partial<ControlState['session']>): void {
    if (this.state === null) return
    this.state = { ...this.state, session: { ...this.state.session, ...patch } }
  }

  private runIsActive(): boolean {
    return this.state?.session.turn === 'running' || this.state?.session.pendingPrompt === true || this.busy
  }

  /* ---- actions ---- */

  private sendSettings(next: Partial<Settings>): void {
    this.notice = null
    this.port.post({ type: 'settings.update', id: crypto.randomUUID(), settings: next })
  }

  private respondToApproval(id: string, decision: ApprovalDecision): void {
    this.answered.add(id)
    this.approvals.delete(id)
    this.port.post({ type: 'approval.respond', id, decision })
    this.renderTranscript()
  }

  private submit(): void {
    const value = this.draft.trim()
    if (value === '') return
    const intent = classifyInput(value)
    this.composerError = null
    if (intent.kind === 'command') this.runCommand(intent)
    else if (intent.kind === 'open') this.runOpen(intent)
    else if (intent.kind === 'error') {
      // 格式出错的指令只发生在用户和解析器之间。把这句解释发给模型，比没用还糟：
      // 它看起来像一条指令，用户会一直等着它得到回复。
      this.composerError = describeOpenError(this.locale, intent.error)
      this.refreshComposerMeta()
    } else void this.runPrompt(intent.text)
  }

  /**
   * 执行一条 `@open` 指令：开页面的是扩展，不是模型。
   *
   * 这条指令的意义就在于，"打开这个让我看看"不能取决于模型同不同意，
   * 所以这里没有任何东西经过会话。
   */
  private runOpen(intent: Extract<InputIntent, { kind: 'open' }>): void {
    const echo = intent.echo
    this.busy = true
    this.refreshForTurn()
    void this.port.call({
      type: 'open.run',
      id: '',
      url: intent.url,
      pace: intent.options.pace,
      pin: intent.options.pin,
    })
      .then(() => {
        this.draft = ''
        this.busy = false
        this.refreshForTurn()
      })
      .catch((error: unknown) => {
        this.busy = false
        this.composerError = error instanceof Error ? error.message : String(error)
        this.draft = echo
        this.refreshForTurn()
      })
  }

  /** 执行用户敲的一条浏览器命令；敲下它本身就是同意。 */
  private runCommand(intent: Extract<InputIntent, { kind: 'command' }>): void {
    const echo = intent.echo
    this.busy = true
    this.refreshForTurn()
    void this.port.call({ type: 'command.run', id: '', name: intent.name, args: intent.args })
      .then(() => {
        this.draft = ''
        this.busy = false
        this.refreshForTurn()
      })
      .catch((error: unknown) => {
        this.busy = false
        this.composerError = error instanceof Error ? error.message : String(error)
        // 把这段文本留下，这样被拒的命令还能改，不用重敲一遍。
        this.draft = echo
        this.refreshForTurn()
      })
  }

  /** 把自然语言转发给桌面端 dsh 模型。 */
  private async runPrompt(text: string): Promise<void> {
    this.busy = true
    this.composerError = null
    this.refreshForTurn()
    try {
      // 会话只读一次：下面每个 await 都可能和一次 `state` 推送交错，
      // 而 prompt 绝不能发给 null 会话。
      let sessionId = this.state?.session.id ?? null
      if (sessionId === null) {
        const created = await this.port.call({ type: 'session.create' })
        if (created.sessionId === undefined) throw new Error('session.create returned no session id')
        sessionId = created.sessionId
      }
      await this.port.call({ type: 'session.prompt', id: '', text })
      this.draft = ''
      this.run = { assistantText: '', plan: null }
      this.setSession({ id: sessionId, pendingPrompt: true })
      this.refreshForTurn()
    } catch (error: unknown) {
      this.busy = false
      this.composerError = error instanceof Error ? error.message : String(error)
      this.refreshForTurn()
    }
  }

  private stopRun(): void {
    void this.port.call({ type: 'session.cancel', id: '' })
      .catch((error: unknown) => {
        this.composerError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        this.busy = false
        this.refreshForTurn()
      })
  }

  /* ---- rendering ---- */

  private render(): void {
    const draft = this.draft
    // 旧的滚动器马上要被丢掉，所以替换之前先读它：读者正在看的东西得在重建里活
    // 下来。记住的那个值只是完全没有 DOM 时（第一次绘制）的兜底，活的 DOM 总比过期的
    // 数字强。
    const previous = this.root.querySelector('.transcript')
    const restore = previous === null
      ? this.restoreScroll
      : atBottom(previous)
        ? null
        : previous.scrollTop

    const shell = el('div', { className: 'app' })
    const transcript = el('div', { className: 'transcript' })
    const inner = el('div', { className: 'transcript__inner' })
    this.fillTranscript(inner)
    transcript.append(inner)
    shell.append(this.header(), transcript, this.composerWrap())
    if (this.settingsOpen) shell.append(this.settingsSheet())
    this.root.replaceChildren(shell)
    this.draft = draft
    // 把这个值重新写回去：任何重绘都不该在框里留下过期文本，placeholder 要留在它该在的
    // 地方——attribute 里。
    this.refreshComposerValue()
    // `null` 表示读者本来就在底部，也只有这个状态会跟着尾部走；别的位置都把他们留在
    // 正在读的地方。
    this.restoreScroll = restore
    if (restore === null) transcript.scrollTop = transcript.scrollHeight
    else transcript.scrollTop = restore
  }

  private fillTranscript(inner: Element): void {
    if (this.backgroundDown) {
      inner.append(this.noticeNode(this.copy.common.reconnectFailed, null, 'alert', true))
    }
    // 另一个浏览器占着连接。照实说出来，并给出唯一一条回去的路：扩展不会自己把位置
    // 抢回来，因为两个开着的浏览器这么干会互相把对方踢掉，转成死循环。
    if (this.state?.replaced === true) {
      inner.append(this.noticeNode(this.copy.bridge.replaced, null, 'alert', true, {
        label: this.copy.bridge.reclaim,
        onClick: () => { this.port.post({ type: 'bridge.reclaim' }) },
      }))
    }
    // 连接被 bridge 明确拒绝：装错构建、扩展 id 不在白名单、或令牌不对。这一类失败和
    // "桌面端没开"长得一模一样，却只有它是用户自己能修的，所以必须点名说出来。
    const rejection = this.state?.bridgeRejection
    if (rejection !== null && rejection !== undefined && this.state?.bridge !== 'connected') {
      inner.append(this.noticeNode(this.copy.common.bridgeRejected, null, 'alert', true))
    }
    // 跟随失败，正是上面记录会空着、而桌面应用却显示着一段会话的原因；
    // 不说清楚这一点，"没有跟随"和"没有东西可显示"看起来一模一样。
    const followError = this.state?.followError
    if (followError !== null && followError !== undefined) {
      inner.append(this.noticeNode(followError, null, 'info', false))
    }
    if (this.notice !== null) inner.append(this.noticeNode(this.notice, null, 'info', false))
    const affinity = this.state?.affinity
    if (affinity?.status === 'handoff') inner.append(this.handoffNode(affinity))
    else if (affinity?.status === 'lost') {
      inner.append(this.noticeNode(this.copy.tab.lostText, this.copy.tab.lostTitle, 'alert', true))
    }
    for (const request of this.approvals.values()) inner.append(this.approvalNode(request))

    // 清单摆在这次运行上方：用户就是看着它了解请求处理到哪一步了，所以它绝不能
    // 被下面那些实现它的单步工具顶得滚走。
    const plan = this.run.plan
    if (plan !== null) inner.append(this.planNode(plan))

    const rows = this.transcriptRows()
    if (rows.length === 0) {
      inner.append(this.emptyNode())
      return
    }
    for (const row of rows) {
      if (row.kind === 'request') inner.append(this.userNode(row.text))
      else if (row.kind === 'assistant') inner.append(this.assistantNode(row))
      else inner.append(this.toolNode(row))
    }
  }

  /**
   * 原地重绘页头。
   *
   * 页头是面板里另一处从 `state` 渲染的地方，所以一次 state 推送重绘它和记录，把输入框
   * 放在一边——换掉输入框才是弄丢焦点和输入的原因。
   */
  private replaceHeader(): void {
    const existing = this.root.querySelector('.header')
    if (existing === null) {
      this.render()
      return
    }
    existing.replaceWith(this.header())
  }

  /**
   * 只重绘回合边界会改的东西，不重建输入框。
   *
   * `turn/start` 和 `turn/end` 以前会调完整的 `render()`，它替换 textarea，正好在读者
   * 写下一段消息时把焦点和输入丢掉（回复结束时再丢一次）。一个回合变化
   * 能影响的无非是页头、记录、textarea 的*值*、发送/停止按钮和元信息行；textarea
   * *元素* 本身不受其中任何一项影响。
   */
  private refreshForTurn(): void {
    this.replaceHeader()
    this.renderTranscript()
    // 放在动作按钮之前：每个调用方都已经写好新的 `draft`，所以输入框会在回合变化的那个
    // tick 上同步过去，绝不会晚于反映它的按钮。
    this.refreshComposerValue()
    this.refreshComposerAction()
  }

  /**
   * 把 `this.draft` 重新写回实时 textarea，并重跑一次自动增高。
   *
   * textarea 有意活过整个回合——换掉它才是弄丢焦点和输入的原因——但这也意味着
   * 它是局部重绘里唯一不重建的节点，所以它会留着最后敲进去的内容。`submit()` 在
   * promise（`runPrompt`、`runCommand`、`runOpen`）里清空 `this.draft`，少了这一步，刚发出去的
   * 那句话就还留在框里：看起来像这次发送没发生，再按一次 Enter 就发两遍。
   *
   * 只在值确实不同时才写，能让多余的 no-op 重绘不去动光标——这很重要，因为读者
   * 可能已经在写下一条消息了。
   */
  private refreshComposerValue(): void {
    const input = this.root.querySelector<HTMLTextAreaElement>('.composer__input')
    if (input === null) return
    if (input.value === this.draft) return
    input.value = this.draft
    this.autoGrow(input)
  }

  /** 把发送按钮换成停止按钮，或者换回来，同时让 textarea 留在原地。 */
  private refreshComposerAction(): void {
    const existing = this.root.querySelector('#composer-action')
    if (existing === null) {
      this.render()
      return
    }
    const next = this.composerAction()
    next.id = 'composer-action'
    existing.replaceWith(next)
    this.refreshComposerMeta()
  }

  private renderTranscript(): void {
    const inner = this.root.querySelector('.transcript__inner')
    const transcript = this.root.querySelector('.transcript')
    if (inner === null || transcript === null) {
      this.render()
      return
    }
    const pinned = atBottom(transcript)
    inner.replaceChildren()
    this.fillTranscript(inner)
    if (pinned) transcript.scrollTop = transcript.scrollHeight
  }

  /**
   * 把流式重绘合并成每帧一次。
   *
   * delta 到的速度可能远快过显示器刷新，所以来一个重绘一次只是重复同样的活儿，
   * 还让队列无界地涨。立个标志、留到下一个动画帧再重绘，开销就取决于回复长度，
   * 而不是到达速率。
   */
  private renderStreaming(): void {
    if (this.streamRepaintQueued) return
    this.streamRepaintQueued = true
    requestAnimationFrame(() => {
      this.streamRepaintQueued = false
      this.repaintStreaming()
    })
  }

  /** 只重绘那条正在流式的回复，这是它打字时的常态。 */
  private repaintStreaming(): void {
    // 清单和文本在同一个事件里变，所以它跟着气泡一起刷新，不用等一次完整的
    // 记录重绘。
    this.paintPlan()
    // 合成行和仍在运行的持久行都带这个钩子，所以不管 worker 给出的是哪一种，
    // 正在打字的回复都能被找到。
    const bubble = this.root.querySelector('[data-streaming] .msg__text')
    if (bubble === null) {
      // 屏幕上还没有东西在流式。这里整体重建是对的（这一行马上要出现），
      // 而且是每条回复一次，不是每帧一次。
      this.renderTranscript()
      return
    }
    // 要显示的文本从行里读，不从 `run.assistantText` 读：持久行是已提交文本加上
    // 这一次尝试，只取这一次尝试会丢掉它前面的内容。为一条还没进记录的行排队的
    // 回复，会保住屏幕上已有的文本，而不是清空它。
    const row = this.transcriptRows().find((entry) => this.isStreamingRow(entry))
    if (row === undefined) return

    if (bubble.textContent !== row.text) {
      bubble.replaceChildren(...this.assistantBubbleChildren(row.text, true))
    }
    // 只有读者本来没离开尾部，才跟着尾部走。在写之前读会更理想，但滚动偏移不受
    // 替换气泡子节点的影响（变的只是它的高度），所以这里等一次刷新就行。
    const transcript = this.root.querySelector('.transcript')
    if (transcript !== null && atBottom(transcript)) transcript.scrollTop = transcript.scrollHeight
  }

  /** 原地重绘清单，本回合宣布过一份就把它插进去。 */
  private paintPlan(): void {
    const inner = this.root.querySelector('.transcript__inner')
    if (inner === null) return
    const existing = inner.querySelector('.plan')
    const plan = this.run.plan
    if (plan === null) {
      existing?.remove()
      return
    }
    const next = this.planNode(plan)
    if (existing === null) {
      // 放在每行请求之前，这样这份清单读起来就像"这就是那件活儿"，下面的
      // 步骤显然正在一步步做完它。
      const first = inner.querySelector('.msg--user')
      if (first === null) inner.append(next)
      else inner.insertBefore(next, first)
      return
    }
    existing.replaceWith(next)
  }

  /**
   * 本回合的清单：每个任务一行，带模型最后写下的状态。
   *
   * 这是面板对"做到哪一步了？"的回答，工具日志答不上来——日志显示跑过哪些
   * 步骤，这里显示它们属于哪件活儿，包括还没开始的和失败的部分。
   */
  private planNode(plan: Plan): HTMLElement {
    const wrap = el('section', { className: 'plan' })
    const progress = planProgress(plan)
    wrap.append(el('div', {
      className: 'plan__head',
      children: [
        el('span', { className: 'plan__title', text: this.copy.plan.title }),
        el('span', {
          className: 'plan__count',
          text: this.copy.plan.progress
            // 只有真正完成的任务才算已完成。把失败也算进去，就会在两行标着失败
            // 的任务旁边显示"5/5 已完成"，那就是面板在说一件它自己都看得出不成立的
            // 事。
            .replace('{done}', String(progress.done))
            .replace('{failed}', String(progress.failed))
            .replace('{total}', String(progress.total)),
        }),
      ],
    }))
    const list = el('ol', { className: 'plan__list' })
    for (const task of plan.tasks) {
      const state = task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : task.status === 'active' ? 'active' : 'pending'
      const mark = task.status === 'done' ? '✓' : task.status === 'failed' ? '✕' : task.status === 'active' ? '▸' : ''
      list.append(el('li', {
        className: `plan__task plan__task--${state}`,
        children: [
          el('span', { className: 'plan__mark', text: mark }),
          el('span', { className: 'plan__text', text: task.text }),
        ],
      }))
    }
    wrap.append(list)
    return wrap
  }

  private header(): HTMLElement {
    const state = this.state
    const bridge = state?.bridge ?? 'stopped'
    // 面板标题已经由浏览器的侧边面板外框显示了，所以页头只放会变的东西：
    // 受控页面、连接状态、设置入口。
    const pill = el('span', {
      className: 'header__tab',
      attributes: { title: state === null ? this.copy.common.reconnecting : this.copy.tab.controlled },
    })
    pill.append(
      el('span', { className: `dot dot--${bridge}` }),
      el('span', { className: 'header__tab-text', text: controlledTabText(state?.affinity ?? emptyAffinity(), this.copy) }),
    )

    const actions = el('div', { className: 'header__actions' })
    if (state !== null && state.affinity.status === 'lost') {
      actions.append(el('button', {
        className: 'btn btn--outlined',
        text: this.copy.tab.bind,
        attributes: { type: 'button' },
        on: { click: () => { this.port.post({ type: 'affinity.rebind', id: crypto.randomUUID() }) } },
      }))
    }
    const settingsButton = iconButton('settings', this.copy.settings.heading, () => { this.toggleSettings(true) })
    // 留一个稳定的钩子：不然只能靠标签认出这个按钮，而标签随界面语言
    // 变，靠文本找它的测试换一台报别的语言的机器就挂。
    settingsButton.dataset.role = 'settings'
    actions.append(settingsButton)

    return el('header', {
      className: 'header',
      children: [el('div', { className: 'header__spacer' }), pill, actions],
    })
  }

  private settingsSheet(): HTMLElement {
    const sheet = el('div', { className: 'sheet' })
    sheet.append(el('div', {
      className: 'sheet__head',
      children: [
        iconButton('close', this.copy.common.close, () => { this.toggleSettings(false) }),
        el('span', { className: 'sheet__title', text: this.copy.settings.heading }),
      ],
    }))
    const body = el('div', { className: 'sheet__body' })
    this.fillSettingsBody(body)
    sheet.append(body)
    return sheet
  }

  /**
   * 把设置行建进一个已经有的主体里。
   *
   * 单独拆出来，是为了让一次 state 推送能刷新这些行——包括里面的连接徽章——
   * 而不重建整张表：重建会丢掉滚动位置，还会关掉已经打开的下拉。被换掉的只有
   * 主体；页头和它的关闭按钮留在原地。
   */
  private fillSettingsBody(body: Element): void {
    const settings = this.state?.settings ?? normalizeSettings(undefined)
    // 只留下用户真正能做的选择：bridge 地址、token、审批通知的兜底，
    // Chrome-over-loopback 这条路已经替他们定好了。需要
    // 人介进来的情况，由一个已安装的排查技能覆盖。
    body.replaceChildren(
      this.connectionSetting(),
      this.sharingSetting(settings),
      this.conversationSetting(settings),
      this.tabSwitchSetting(settings),
      this.visionSetting(settings),
      // 这一行没有说明文字：标签本身已经问得很清楚了，多一句解释只是噪音。
      this.switchSetting(this.copy.settings.autoOpen, settings.autoOpenPanel, undefined, (checked) => {
        this.sendSettings({ autoOpenPanel: checked })
      }),
      this.switchSetting(this.copy.settings.unrestricted, settings.unrestrictedBrowserAccess, this.copy.settings.unrestrictedHelp, (checked) => {
        this.sendSettings({ unrestrictedBrowserAccess: checked })
      }),
      el('div', {
        className: 'setting',
        children: [el('div', { className: 'setting__help', text: this.copy.settings.widthHint })],
      }),
    )
  }

  /**
   * 刷新已经打开的设置表，但只在它画出来的东西变了的时候。
   *
   * 以前每一次 `state` 推送都重建这张表，而回复流式到达时每 50 ms 就推一次。
   * 表里有四个 `<select>` 和两个开关，每秒重建二十次会把拿到焦点的控件毁掉、把
   * 打开的下拉关掉——这张表偏偏就在有人要动它的时候变得没法用。它画出来的东西
   * 只取决于设置与策略，所以下面这次比较就是全部的输入。
   */
  private refreshSettingsSheet(): void {
    const body = this.root.querySelector('.sheet__body')
    if (body === null) return
    const fingerprint = JSON.stringify({
      settings: this.state?.settings ?? null,
      policy: this.state?.policy ?? null,
    })
    if (fingerprint === this.settingsFingerprint) return
    this.settingsFingerprint = fingerprint
    this.fillSettingsBody(body)
  }

  /**
   * 图像识别做到什么程度。
   *
   * 这个功能在这里只需要这一个控件。调用发到哪儿——桌面端，还是浏览器
   * 够得着的一个 endpoint——属于部署配置，不该由设置表来问：桌面端的 base URL
   * 和模型都有默认值，而被问一个 model id 不算选择，是件杂务。
   */
  private visionSetting(settings: Settings): HTMLElement {
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.visionTier } })
    for (const [value, label] of [
      ['off', this.copy.settings.visionTierOff],
      ['low', this.copy.settings.visionTierLow],
      ['standard', this.copy.settings.visionTierStandard],
      ['enhanced', this.copy.settings.visionTierEnhanced],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.visionTier === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      const tier = select.value
      if (tier !== 'off' && tier !== 'low' && tier !== 'standard' && tier !== 'enhanced') return
      this.sendSettings({ visionTier: tier })
    })
    return this.settingRow(this.copy.settings.visionTier, select, this.copy.settings.visionTierHelp)
  }

  /**
   * 面板在和桌面端的哪段会话对话。
   *
   * 三档：在浏览器工作区里新建一段、接着上一段、或镜像全部工作区。目标只能选，从不推断 ——
   * 桌面端没发出任何"我正在查看的会话"信号，所以一个靠最近活动去猜的模式，会不声不响地把
   * 消息投到错的会话里。
   *
   * 后两档原先各有一个手选的会话下拉（`pinned` 那档）。它已经删掉了：那套手选 id 和
   * 「上次那段」已经记住的 id 是同一件事的两处真相来源，合并之后不再需要选。
   */
  private conversationSetting(settings: Settings): HTMLElement {
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.conversation } })
    for (const [value, label] of [
      ['fresh', this.copy.settings.conversationFresh],
      ['last', this.copy.settings.conversationLast],
      ['workspace', this.copy.settings.conversationWorkspace],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.sessionScope === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      // 三档都不需要目标：`workspace` 镜像的集合由 worker 自己去读，另外两档用记住的那段对话。
      // `select.value` 就是上面那三个字面量之一，这里的断言只是把它带回联合类型。
      void this.port.call({ type: 'session.select', id: '', scope: select.value as Settings['sessionScope'], sessionId: null })
    })
    return this.settingRow(this.copy.settings.conversation, select, this.copy.settings.conversationHelp)
  }

  /**
   * 手动切一次标签页之后，事情怎么收尾。
   *
   * 这以前是每次切换时写在记录里的一段提示，用户要求挪到这里：答案已经知道了，
   * 再问一次就是噪音。
   */
  private tabSwitchSetting(settings: Settings): HTMLElement {
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.tabSwitch } })
    for (const [value, label] of [
      ['follow', this.copy.settings.tabSwitchFollow],
      ['keep', this.copy.settings.tabSwitchKeep],
      ['ask', this.copy.settings.tabSwitchAsk],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.tabSwitch === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      this.sendSettings({ tabSwitch: select.value as Settings['tabSwitch'] })
    })
    return this.settingRow(this.copy.settings.tabSwitch, select, this.copy.settings.tabSwitchHelp)
  }

  private toggleSettings(open: boolean): void {
    this.settingsOpen = open
    const shell = this.root.querySelector('.app')
    if (shell === null) {
      this.render()
      return
    }
    const existing = shell.querySelector('.sheet')
    if (open) {
      if (existing === null) {
        shell.append(el('button', {
          className: 'scrim',
          attributes: { type: 'button', tabindex: '-1', 'aria-label': this.copy.common.close },
          on: { click: () => { this.toggleSettings(false) } },
        }), this.settingsSheet())
      }
      return
    }
    shell.querySelector('.scrim')?.remove()
    existing?.remove()
  }

  private emptyNode(): HTMLElement {
    // 空着就是空着：面板是拿来对话的，不是拿来上教程的，也不是拿来报「准备就绪」的。
    // 保留这个空节点（而不是不渲染）是为了让 `.empty` 的留白仍然把记录区撑开。
    return el('div', { className: 'empty' })
  }

  private noticeNode(
    text: string,
    title: string | null,
    iconName: IconName,
    warning: boolean,
    action?: { label: string; onClick: () => void },
  ): HTMLElement {
    const body = el('div', {
      className: 'notice__body',
      children: [
        ...(title === null ? [] : [el('div', { className: 'notice__title', text: title })]),
        el('div', { className: 'notice__text', text }),
      ],
    })
    if (action !== undefined) {
      body.append(el('button', {
        className: 'btn btn--outlined notice__action',
        text: action.label,
        attributes: { type: 'button' },
        on: { click: action.onClick },
      }))
    }
    return el('div', {
      className: warning ? 'notice notice--warning' : 'notice',
      children: [icon(iconName, 16), body],
    })
  }

  private handoffNode(affinity: TabAffinityState): HTMLElement {
    const decide = (decision: 'keep' | 'follow' | 'keep-always'): void => {
      this.port.post({ type: 'affinity.respond', revision: affinity.revision, decision })
    }
    const active = affinity.active
    const text = active === null ? this.copy.tab.handoffText : `${this.copy.tab.handoffText} — ${active.title || active.url}`
    return el('div', {
      className: 'notice notice--warning',
      children: [
        icon('alert', 16),
        el('div', {
          className: 'notice__body',
          children: [
            el('div', { className: 'notice__title', text: this.copy.tab.handoffTitle }),
            el('div', { className: 'notice__text', text }),
            el('div', {
              className: 'notice__actions',
              children: [
                el('button', { className: 'btn btn--outlined', text: this.copy.tab.keep, attributes: { type: 'button' }, on: { click: () => decide('keep') } }),
                el('button', { className: 'btn btn--primary', text: this.copy.tab.follow, attributes: { type: 'button' }, on: { click: () => decide('follow') } }),
                el('button', { className: 'btn', text: this.copy.tab.keepAlways, attributes: { type: 'button' }, on: { click: () => decide('keep-always') } }),
              ],
            }),
          ],
        }),
      ],
    })
  }

  private approvalNode(request: ApprovalRequest): HTMLElement {
    const card = el('div', { className: 'approval' })
    // 先说清楚在问什么，再说它会做什么。没有这一行，卡片一打开就是工具自己的摘要
    // （"点击元素 [3]"），读着像机器输出，用户还得自己反应过来：原来这是在问我一个
    // 问题。
    card.append(el('p', {
      className: 'approval__ask',
      text: request.kind === 'read' ? this.copy.approval.askRead : this.copy.approval.askAction,
    }))
    card.append(el('p', { className: 'approval__summary', text: request.summary }))
    // 来源写成文字，不做成标签：它是决定答案的那个事实，就该读起来像
    // 摘要旁边的一句话。
    const origins = request.origins.length === 0
      ? this.copy.approval.unknownOrigin
      : request.origins.join(' · ')
    card.append(el('p', { className: 'approval__origin', text: origins }))

    const actions = el('div', { className: 'approval__actions' })
    for (const decision of approvalDecisions(request)) {
      const label = decision === 'deny'
        ? this.copy.approval.deny
        : decision === 'allow-once'
          ? this.copy.approval.allowOnce
          : decision === 'always-allow-reads'
            ? this.copy.approval.alwaysAllowReads
            : this.copy.approval.trustSession
      actions.append(el('button', {
        className: decision === 'deny' ? 'btn btn--outlined' : 'btn btn--primary',
        text: label,
        attributes: { type: 'button' },
        on: { click: () => { this.respondToApproval(request.id, decision) } },
      }))
    }
    card.append(actions)
    return card
  }

  private userNode(text: string): HTMLElement {
    return el('div', {
      className: 'msg msg--user',
      children: [el('div', { className: 'msg__bubble', text })],
    })
  }

  private assistantBubbleChildren(text: string, streaming: boolean): Node[] {
    const nodes: Node[] = []
    if (streaming) {
      // 回复还在打字时按纯文本显示。这里渲染 Markdown 会让每个 delta 都把整条回复
      // 重新解析、重新消毒一遍，长答案冻住面板就是这个原因；已完成的回复在下一行
      // 走正常的渲染。
      if (text !== '') nodes.push(el('div', { text }))
    } else if (hasMarkdownContent(text)) {
      const html = el('div')
      // 这个文件里唯一一处 innerHTML，输入是消过毒的 markdown。
      html.innerHTML = renderMarkdown(text)
      nodes.push(...html.childNodes)
    }
    if (streaming) nodes.push(el('span', { className: 'caret', attributes: { 'aria-hidden': 'true' } }))
    return nodes
  }

  private assistantNode(row: TimelineEntry): HTMLElement {
    const streaming = this.isStreamingRow(row)
    const bubble = el('div', { className: 'msg__text' })
    bubble.append(...this.assistantBubbleChildren(row.text, streaming))
    return el('div', {
      className: streaming ? 'msg msg--assistant msg--streaming' : 'msg msg--assistant',
      // 仍在运行的持久行会打个标记，好让流式重绘找到它、原地更新文本，
      // 而不是重建整份记录。
      attributes: streaming ? { 'data-streaming': 'true' } : {},
      children: [bubble],
    })
  }

  /**
   * 判断一行是不是那条正在输入的回复。
   *
   * 一行有两种方式算作流式中，只认第一种正是长回复一直很慢的原因：
   * worker 在第一个 delta 就建一条持久的 `assistant` 行，整个回合都把它更新成
   * `running`，于是下面那条合成行从来没被加上，而那条持久行——它在真实应用里才是*正常*
   * 情况——每帧都被当成已完成的 Markdown 渲染。
   */
  private isStreamingRow(row: TimelineEntry): boolean {
    if (row.id === STREAMING_ID) return true
    return row.kind === 'assistant' && row.state === 'running'
  }

  private toolNode(row: TimelineEntry): HTMLElement {
    const detailId = `tool-${row.id}`
    const open = this.expanded.has(row.id)
    const button = el('button', {
      className: 'tool-line',
      attributes: { type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': detailId },
      on: {
        click: () => {
          if (this.expanded.has(row.id)) this.expanded.delete(row.id)
          else this.expanded.add(row.id)
          this.renderTranscript()
        },
      },
    })
    const iconClass = row.state === 'running'
      ? 'tool-line__icon tool-line__icon--running'
      : row.state === 'failed'
        ? 'tool-line__icon tool-line__icon--failed'
        : row.state === 'denied'
          ? 'tool-line__icon tool-line__icon--denied'
          : 'tool-line__icon'
    const marker = icon(markerIcon(row.state), 14)
    marker.setAttribute('class', iconClass)
    button.append(marker, el('span', {
      className: 'tool-line__text',
      text: row.text === '' ? toolLabel(row.tool, this.copy) : row.text,
    }))

    const wrapper = el('div', { className: 'msg msg--tool', children: [button] })
    if (open) {
      wrapper.append(el('div', {
        className: 'tool-detail',
        attributes: { id: detailId },
        text: [
          `${this.copy.timeline.tool}: ${row.tool ?? '—'}`,
          `${this.copy.timeline.result}: ${stateText(row.state, this.locale)}`,
          ...(row.callId === undefined ? [] : [`ID: ${row.callId}`]),
        ].join('\n'),
      }))
    }
    return wrapper
  }

  /** 记录里的各行，流式中的那条回复在传输期间追加在后面。 */
  private transcriptRows(): TimelineEntry[] {
    const settled = this.state !== null
      ? timelineFromState(this.state)
      : this.activity.slice().reverse().map((entry) => ({
          id: entry.id,
          kind: 'step' as const,
          text: entry.summary,
          tool: entry.name,
          state: entry.state,
          at: entry.at,
          callId: entry.id,
        }))
    // 持久的 assistant 行要等回合结束才到，所以在那之前，实时文本显示为一条合成
    // 行。持久行一出现就渲染它：答案永远不会出现两次。
    if (this.run.assistantText.trim() === '') return settled
    if (settled.some((row) => row.kind === 'assistant')) return settled
    return [...settled, {
      id: STREAMING_ID,
      kind: 'assistant' as const,
      text: this.run.assistantText,
      state: this.runIsActive() ? 'running' as const : 'done' as const,
      at: Date.now(),
    }]
  }

  /**
   * 输入框的发送或停止控件。
   *
   * 单独拆出来，是因为回合边界只改这一个按钮，为了拿到它去换掉整个输入框，就会换掉
   * 读者正在打字的那个 textarea。
   */
  private composerAction(): HTMLButtonElement {
    const button = this.runIsActive()
      ? el('button', {
          className: 'btn btn--icon',
          attributes: { type: 'button', title: this.copy.composer.stop, 'aria-label': this.copy.composer.stop },
          on: { click: () => { this.stopRun() } },
          children: [icon('stop', 16)],
        })
      : el('button', {
          className: 'btn btn--primary btn--icon',
          attributes: { type: 'button', title: this.copy.composer.send, 'aria-label': this.copy.composer.send },
          on: { click: () => { this.submit() } },
          children: [icon('send', 16)],
        })
    if (this.busy) button.setAttribute('disabled', 'true')
    // 打个标记，好让回合边界能找到并精确替换这一个节点。
    button.id = 'composer-action'
    return button
  }

  private composerWrap(): HTMLElement {
    const wrap = el('div', { className: 'composer-wrap' })
    const box = el('div', { className: 'composer__box' })
    const input = el('textarea', {
      className: 'composer__input',
      attributes: {
        rows: '1',
        'aria-label': this.copy.composer.placeholder,
        placeholder: this.copy.composer.placeholder,
      },
    })
    // 显式清空：placeholder 是一个 attribute，这个框绝不能一打开里面就有文本。
    input.value = this.draft
    input.addEventListener('input', () => {
      this.draft = input.value
      this.autoGrow(input)
      this.refreshComposerMeta()
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        this.submit()
      }
    })

    box.append(input, this.composerAction())
    wrap.append(el('div', { className: 'composer', children: [box, this.composerMeta()] }))
    queueMicrotask(() => { this.autoGrow(input) })
    return wrap
  }

  /**
   * 让输入框长到刚好装下草稿，最多长到一个固定上限。
   *
   * 这个上限和样式表里的 `max-height` 对齐。这里用视口比例是错的：同一份草稿会随窗口
   * 大小占掉面板的不同比例，窗口一高，输入框就把对话挤出去了。
   */
  private autoGrow(input: HTMLTextAreaElement): void {
    const MAX_INPUT_HEIGHT = 160
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }

  private composerMeta(): HTMLElement {
    const meta = el('div', { className: 'composer__meta' })
    meta.id = 'composer-meta'
    meta.append(...this.composerMetaChildren())
    return meta
  }

  /**
   * 输入框下面的那一行。
   *
   * 没话说就是空的：就绪的面板不显示语法教程，已输入的草稿也只在有
   * 问题时才报（一次发送失败，或者 bridge 断开时的一次模型请求）。唯一的例外是以
   * `@` 开头的草稿，因为指令猜不出来——在输入的过程中显示它的格式，是唯一
   * 能学到它的地方。
   */
  private composerMetaChildren(): Node[] {
    if (this.composerError !== null) {
      return [el('span', { className: 'composer__error', text: this.composerError })]
    }
    const draft = this.draft.trim()
    if (draft.startsWith('@')) {
      const intent = classifyInput(draft)
      // 写了一半的指令按安静的提示显示——是格式提醒，不是抱怨
      // ——真正的错误才按错误显示。这个区分来自解析器（`isSoftOpenError`），
      // 不看措辞：靠判断消息是不是以某个中文短语开头，意味着这个提示在
      // 英文下会消失，而浏览器本来就有理由用中文抱怨。
      if (intent.kind === 'error') {
        const className = isSoftOpenError(intent.error) ? 'composer__hint' : 'composer__error'
        return [el('span', { className, text: describeOpenError(this.locale, intent.error) })]
      }
      return [el('span', { className: 'composer__hint', text: this.copy.composer.openHint })]
    }
    const intent = classifyInput(draft)
    if (draft !== '' && this.state?.bridge !== 'connected' && intent.kind !== 'command' && intent.kind !== 'open') {
      return [el('span', { className: 'composer__error', text: this.copy.composer.disconnected })]
    }
    return []
  }

  private refreshComposerMeta(): void {
    const meta = this.root.querySelector('#composer-meta')
    if (meta === null) return
    meta.replaceChildren(...this.composerMetaChildren())
  }

  /**
   * 面板对桌面应用"为用户打开页面"这个开关的看法。
   *
   * 徽章报的是*连接*，不是那个值。握手之前根本还没有任何策略，把那种状态标成
   * "不允许"会让一个好好的扩展看起来是坏的——所以徽章只说 已连接/未连接，页面
   * 能不能被打开由帮助行交代，那才是它该待的地方。
   *
   * 有意做成只读。这个设置归桌面应用，所以面板只把它说出来、告诉你去哪儿改，而不是
   * 给一个会被应用立刻覆盖掉的控件。
   */
  /**
   * 设置面板第一行：**连接状态**，只读。
   *
   * 它原先叫 `openPagesSetting`，却用 `policy !== null` 判断「已连接」——那问的是
   * 「宿主有没有下发 policy」，不是「扩展连上没有」。两件事通常同时为真，所以错得
   * 不明显；但一边是连接事实、一边是桌面端的策略字段，任一为假就会显示反的状态。
   * 现在按 `state.bridge` 如实显示，和顶部状态点同一个来源、同一套颜色。
   */
  private connectionSetting(): HTMLElement {
    const bridge = this.state?.bridge ?? null
    // 徽章只放短语；「要先打开 dsh」这类整句留给下面的说明行与 title，别挤进徽章。
    const short = bridge === null
      ? this.copy.settings.connectionOff
      : bridge === 'connected'
        ? this.copy.settings.connectionOn
        : bridge === 'stopped' ? this.copy.settings.connectionOff : this.copy.settings.connectionConnecting
    // 三种情况分开说：连上了、明确断了、还没收到任何 state。「断了」和「还没消息」
    // 原因相同但严重程度不同，用同一句话会让"刚打开面板"和"连接掉了"看起来一样。
    const help = bridge === null
      ? this.copy.settings.connectionUnknown
      : bridge === 'stopped' ? this.copy.settings.connectionOffHelp : this.copy.settings.connectionHelp
    return el('div', {
      className: 'setting',
      children: [
        el('div', {
          className: 'setting__row',
          children: [
            el('div', { className: 'setting__label', text: this.copy.settings.connection }),
            el('span', {
              className: bridge === 'connected' ? 'badge badge--on' : 'badge',
              // 状态点是给眼睛的，这枚徽章是配给它的字；两者读同一个值。
              text: short,
              attributes: { title: help },
            }),
          ],
        }),
        el('div', { className: 'setting__help', text: help }),
      ],
    })
  }

  private sharingSetting(settings: Settings): HTMLElement {
    const select = el('select', { className: 'select', attributes: { 'aria-label': this.copy.settings.sharing } })
    for (const [value, label] of [
      ['ask', this.copy.settings.sharingAsk],
      ['auto', this.copy.settings.sharingAuto],
    ] as const) {
      const option = el('option', { text: label, attributes: { value } })
      if (settings.sharePageContent === value) option.selected = true
      select.append(option)
    }
    select.addEventListener('change', () => {
      this.sendSettings({ sharePageContent: select.value as Settings['sharePageContent'] })
    })
    return this.settingRow(this.copy.settings.sharing, select, this.copy.settings.sharingHelp)
  }


  /**
   * 一行设置：标签 + 控件，下面跟一句说明。
   *
   * `help` 是可选的。没有说明时不渲染空的 `.setting__help`——留一个空 div 只会多出一段
   * 没有内容的行距，看着像漏了字。（那条 CSS 用了 `pre-wrap`，正是靠它渲染多行说明。）
   */
  private settingRow(label: string, control: Node, help?: string): HTMLElement {
    const row = el('div', { className: 'setting__row', children: [el('div', { className: 'setting__label', text: label }), control] })
    return el('div', {
      className: 'setting',
      children: help === undefined || help === ''
        ? [row]
        : [row, el('div', { className: 'setting__help', text: help })],
    })
  }

  private switchSetting(label: string, checked: boolean, help: string | undefined, onChange: (checked: boolean) => void): HTMLElement {
    const input = el('input', { attributes: { type: 'checkbox', 'aria-label': label } })
    input.checked = checked
    input.addEventListener('change', () => { onChange(input.checked) })
    const control = el('span', {
      className: 'switch',
      children: [input, el('span', { className: 'switch__track' }), el('span', { className: 'switch__thumb' })],
    })
    return this.settingRow(label, control, help)
  }

  /** 把页面标成与 worker 断开，不臆造任何状态。 */
  markOffline(): void {
    if (this.backgroundDown) return
    this.backgroundDown = true
    this.render()
  }
}

/** 仍在流式的那条回复用的合成行 id。 */
const STREAMING_ID = '__streaming__'

/** 把页面挂到 document 上。入口点和测试都用它。 */
export function mountControlPage(
  root: HTMLElement,
  locale: UiLocale = getUiLocale(),
  portOverride?: ControlPort,
): { app: App; port: ControlPort } {
  const copy = controlCopy(locale)
  let app: App
  const port = portOverride ?? new ControlPort(
    (message) => { app.handleMessage(message) },
    (connected) => {
      if (!connected) app.markOffline()
    },
  )
  app = new App(root, locale, port, copy)
  app.start()
  return { app, port }
}

function main(): void {
  const root = document.getElementById('control-root')
  if (root !== null) {
    const mounted = mountControlPage(root)
    // 一个通向实时面板的句柄。没有 devtools 路径能进侧边面板的模块作用域，所以没有
    // 它的话，运行中的界面就没法从页面控制台里检查或驱动——布局测量脚本正是靠它
    // 喂真实内容，而不是注入绕过渲染路径的 HTML。
    ;(globalThis as { __dshPanel?: unknown }).__dshPanel = mounted
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true })
  else main()
}
