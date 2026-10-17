/**
 * 整页控制 UI 的实时会话视图：助手流式文本、执行时间线，以及页面渲染要看的轮次/队列标志。
 *
 * worker 一辈子只持有一个 dsh 会话，也不存任何持久数据：没有 transcript、没有历史、没有帧
 * 缓冲。会话日志归桌面 dsh 应用，而轮次中途打开的页面会照着推来的 `ControlState` 重绘，所以
 * 这里没有东西会被持久化或者重放。
 *
 * @module
 */

import type { ActivityEntry, AssistantStreamEvent, ControlState, TimelineEntry } from '../settings.ts'

/** 时间线最多留几行；满了就丢最旧的。 */
export const TIMELINE_LIMIT = 200

/**
 * 两次流式发布之间最少隔多久。
 *
 * 每次发布都要克隆整段助手文本、再通过 port 发出去；按快模型的流式速度，每个 delta 都发一遍
 * 既浪费，代价还会随回复长度二次增长。50 ms 让文本看着仍然是实时的（每秒 20 次更新，比人读得
 * 还快），同时把跨进程开销绑在流逝的时间上，而不是 delta 的个数上。
 */
export const STREAM_NOTIFY_MS = 50

/** 会话视图变了的时候，通知页面重绘的出口。 */
export interface ControlSessionSinks {
  /** 在页面需要重绘的变化之后调；绝不按流式 delta 调。 */
  changed(): void
}

let idSequence = 0

function newId(prefix: string): string {
  idSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把一次 `session/assistant-stream` 推送规整成当前会话的形式。
 *
 * bridge payload 是 `{ sessionId, snapshotId?, frame }`；`snapshot` 帧是权威基线，其余每个帧都是
 * 密集 delta。port 事件照搬了这个区分：snapshot 把 `snapshotId` 放在帧旁边
 * （`{ snapshotId?, frame }`），而 delta 就是它的帧本身。别的会话的帧一律丢掉：一个 worker 只跟
 * 一个会话，共用一个 bridge 的第二个 dsh 窗口不许画进这个页面的对话里。
 * @param payload - 原始 bridge payload。
 * @param activeSessionId - 这个 worker 驱动的会话（如果有）。
 * @returns 要转发的 port 事件；不属于本会话时返回 null。
 */
export function assistantStreamEvent(payload: unknown, activeSessionIds: ReadonlySet<string>): AssistantStreamEvent | null {
  if (!isRecord(payload)) return null
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || !activeSessionIds.has(sessionId)) return null
  const frame = payload.frame
  if (!isRecord(frame)) return null
  if (frame.type !== 'snapshot') return { sessionId, kind: 'delta', payload: frame }
  const snapshotId = payload.snapshotId
  return {
    sessionId,
    kind: 'snapshot',
    payload: {
      ...(typeof snapshotId === 'string' && snapshotId !== '' ? { snapshotId } : {}),
      frame,
    },
  }
}

/** 一条规整过的 assistant-stream 事件里的流式帧。 */
function streamFrame(event: AssistantStreamEvent): Record<string, unknown> | undefined {
  if (!isRecord(event.payload)) return undefined
  if (event.kind !== 'snapshot') return event.payload
  const frame = event.payload.frame
  return isRecord(frame) ? frame : undefined
}

/**
 * 把一次 `session/event` 推送规整成当前会话的形式。
 *
 * 事件原样往下转：工具调用、消息、轮次边界都由页面自己渲染，worker 只判断它属不属于正在驱动的
 * 那个会话。
 * @param payload - 原始 bridge payload。
 * @param activeSessionId - 这个 worker 驱动的会话（如果有）。
 * @returns 要转发的 port 消息；不属于本会话时返回 null。
 */
export function sessionEventMessage(
  payload: unknown,
  activeSessionIds: ReadonlySet<string>,
): { sessionId: string; event: unknown } | null {
  if (!isRecord(payload)) return null
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || !activeSessionIds.has(sessionId)) return null
  const event = payload.event
  if (!isRecord(event)) return null
  return { sessionId, event }
}

/** 把 content 数组里各个 `text` 块拼起来；没有就返回 undefined。 */
function textFromBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.trim() === '') continue
    parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** 一条持久 `assistant/message` 事件里的权威助手文本。 */
function assistantMessageText(event: Record<string, unknown>): string | undefined {
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined) return undefined
  const message = isRecord(data.message) ? data.message : undefined
  return textFromBlocks(message?.content ?? data.content)
}

/**
 * 权威流式基线里带的文本。
 *
 * 基线握着已经开了的那次尝试：`text-chunks` 记录里是一组拼在一起的 delta，裸 `chunk` 记录里
 * 只有一个。
 */
function baselineText(baseline: unknown): string {
  if (!isRecord(baseline)) return ''
  const attempt = baseline.activeAttempt
  if (!isRecord(attempt) || !Array.isArray(attempt.stream)) return ''
  const parts: string[] = []
  for (const record of attempt.stream) {
    if (!isRecord(record)) continue
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      for (const text of record.texts) {
        if (typeof text === 'string') parts.push(text)
      }
      continue
    }
    const chunk = record.type === 'chunk' && isRecord(record.chunk) ? record.chunk : undefined
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
  }
  return parts.join('')
}

/**
 * 供控制页面渲染的会话与时间线。
 *
 * 行按时间排（最旧的在前）且有上限；模型文本每轮只更新**一行**助手行，不是每个 delta 追加
 * 一行；本轮攒下的文本在 `turn/end` 丢掉，所以再长的对话也不会让 worker 的内存涨起来。
 */
export class ControlSession {
  private readonly entries: TimelineEntry[] = []
  private sessionId: string | null = null
  private turn: 'idle' | 'running' = 'idle'
  private pendingPrompt = false
  /** 本轮里由持久消息定下来的助手文本。 */
  private committedText: string[] = []
  /** 自上次提交或基线以来流式到达的文本。 */
  private attemptText = ''
  private assistantRowId: string | null = null
  /** 已经合并、待发布的流式更新；没排程时为 null。 */
  private streamNotifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sinks: ControlSessionSinks) {}

  /** 这个 worker 对话的那个会话；第一条提示之前为 null。 */
  get id(): string | null {
    return this.sessionId
  }

  /**
   * 这个 worker 会把事件转发给面板的每一个对话。
   *
   * 普通模式下只有一项——面板绑定的那个对话——再加上「工作区内」镜像的那些。它永远是个集合，
   * 这样事件路由器不用管当前生效的是哪种模式。
   */
  activeSessionIds(): ReadonlySet<string> {
    const ids = new Set(this.mirrored.keys())
    if (this.sessionId !== null) ids.add(this.sessionId)
    return ids
  }

  /**
   * 正在镜像的那几个额外对话，按 id 索引，各带一个要显示的标签。
   *
   * @param sessions - 「工作区内」正在镜像的对话；传空就是停下。
   */
  setMirrored(sessions: ReadonlyMap<string, string>): void {
    this.mirrored = new Map(sessions)
  }

  /** 某个被镜像对话的标签，给面板的行标题用。 */
  labelFor(sessionId: string): string | undefined {
    return this.mirrored.get(sessionId)
  }

  /** `ControlState.session` 切片。 */
  session(): ControlState['session'] {
    return { id: this.sessionId, turn: this.turn, pendingPrompt: this.pendingPrompt }
  }

  /** `ControlState.timeline` 切片，最旧的行在前。 */
  timeline(): TimelineEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  /** 认下这个 worker 驱动的会话；页面会在 `state` 里报它。 */
  adopt(id: string): void {
    if (this.sessionId === id) return
    this.sessionId = id
    this.sinks.changed()
  }

  /** 已经开始干活的那些行的 id。 */
  inFlightRowIds(activeToolCallIds: Iterable<string>): Set<string> {
    const ids = new Set<string>(activeToolCallIds)
    for (const entry of this.entries) {
      // 已提交的提示还在路上；排队中的工具步骤不算。
      if (entry.kind === 'request' && entry.state === 'pending') ids.add(entry.id)
    }
    return ids
  }

  /**
   * 只留下指定的对话，其余的都忘掉，不属于任何对话的行照留。
   *
   * 「工作区内」镜像的是一组对话，而桌面端一边开新活儿一边归档，这个集合是会变的。这是
   * {@link detach} 的窄版本：离开集合的对话丢掉自己的行，别的对话保住自己的行——这个模式能读
   * 就是因为这一点，一把全清会抹掉用户还在看的那些对话。
   *
   * @param keep - 仍在镜像的会话。
   */
  retainSessions(keep: ReadonlySet<string>): void {
    const dropped = this.entries.filter((entry) => entry.sessionId !== undefined && !keep.has(entry.sessionId))
    if (dropped.length === 0) return
    const kept = this.entries.filter((entry) => entry.sessionId === undefined || keep.has(entry.sessionId))
    this.entries.length = 0
    this.entries.push(...kept)
    // 行跟着它所属的对话一起消失，不能让面板还口口声声说有一轮在跑。
    if (dropped.some((entry) => entry.sessionId === this.sessionId)) {
      this.turn = 'idle'
      this.committedText = []
      this.attemptText = ''
      this.assistantRowId = null
    }
    this.sinks.changed()
  }

  /**
   * 此刻新建的行属于哪个对话。
   *
   * 事件路由器在应用任何东西之前设好它，`push` 再读它，这样「工作区内」能同时镜像多个对话，
   * 而每个产生行的方法不必都捎一个 session id。面板自己的 transcript 是 `null`，因为那里绑定
   * 就是唯一的对话。
   */
  private attributedSessionId: string | null = null

  /** 「工作区内」正在镜像的额外对话：id → 标签。别的模式下都是空的。 */
  private mirrored = new Map<string, string>()

  /**
   * 指定接下来这些行归属哪个对话。
   *
   * @param sessionId - 正在应用的那个对话；面板自己的传 null。
   */
  attributeTo(sessionId: string | null): void {
    this.attributedSessionId = sessionId
  }

  /**
   * 给一行标上它来自哪个对话。
   *
   * @param entry - 马上要追加的行。
   * @returns 该行；正在归属某个会话时会给它设上 `sessionId`。
   */
  private attributed(entry: TimelineEntry): TimelineEntry {
    if (this.attributedSessionId === null) return entry
    return { ...entry, sessionId: this.attributedSessionId }
  }

  /**
   * 把这个会话以及为它显示的一切都忘掉。
   *
   * 用户把面板指向另一个对话、或者指回它自己的某个对话时会走这里。transcript 属于它来自的那个
   * 会话，把这些行留着就等于拿一个对话的历史冒充另一个对话的。
   *
   * `keepIds` 给的是确实还在路上的活儿——已经提交的提示、已经派发的工具。这些行要留下，因为
   * 结果还在路上，抹掉它们就等于抹掉它唯一的迹象。仅仅是*排队中*的行直接丢掉：它还没开始，
   * 而且马上就要在用户刚切走的那个对话上跑。
   *
   * @param keepIds - 已经开始干活的行 id。
   */
  detach(keepIds: ReadonlySet<string> = new Set()): void {
    this.sessionId = null
    // 工具步骤行带的是它所属活动行的 id，不是自己的 id，所以只按 `id` 匹配会悄悄丢掉这个参数
    // 本来要保的那些行——之后到的结果就会新建一行，而不是填进屏幕上已经有的那一行。
    const inFlight = this.entries.filter((entry) => keepIds.has(entry.callId ?? entry.id))
    this.entries.length = 0
    this.entries.push(...inFlight)
    this.turn = 'idle'
    this.committedText = []
    this.attemptText = ''
    this.assistantRowId = null
    // `pendingPrompt` 说的是上面保留下来的那一行，不是已经换掉的那个绑定。
    if (inFlight.length === 0) this.pendingPrompt = false
    this.sinks.changed()
  }

  /**
   * 追加用户提交的请求，并把提示队列标成忙。
   * @param text - 用户提交的文本。
   * @returns 该行 id，这样被拒的提示能精确地丢掉这一行。
   */
  beginPrompt(text: string): string {
    const entry: TimelineEntry = {
      id: newId('request'),
      kind: 'request',
      text,
      state: 'pending',
      at: Date.now(),
      // 下一条提示要去哪个对话；工作区模式下是面板自己的会话，不是任何被镜像的会话。
      ...(this.sessionId === null ? {} : { sessionId: this.sessionId }),
    }
    this.push(entry)
    // 在 gateway 作答之前就置位，不是等准入之后：第一条 `turn/start` 可能在提示回复还在路上时
    // 就到了，而随后的准入不能把这个已经被那一轮清掉的标志又救活。
    this.pendingPrompt = true
    this.sinks.changed()
    return entry.id
  }

  /** gateway 收下了这条提示：从这儿起归桌面端管。 */
  admitPrompt(id: string): void {
    if (this.updateRow(id, { state: 'done' })) this.sinks.changed()
  }

  /** 这条提示压根没到桌面端：丢掉它的行，再把队列标志清掉。 */
  rejectPrompt(id: string): void {
    this.pendingPrompt = false
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index !== -1) this.entries.splice(index, 1)
    this.sinks.changed()
  }

  /** `turn/start`：模型开工了；排队中的提示不再是待处理状态。 */
  startTurn(): void {
    this.turn = 'running'
    this.pendingPrompt = false
    this.resetTurnText()
    this.sinks.changed()
  }

  /** `turn/end`：本轮结束，它的行就算完成，实时文本丢掉。 */
  endTurn(): void {
    this.turn = 'idle'
    this.pendingPrompt = false
    this.settleAssistantRow('done')
    this.resetTurnText()
    this.flushStreamNotify()
    this.sinks.changed()
  }

  /** 用户停掉了本轮：队列里没东西了，得马上说出来。 */
  cancelTurn(): void {
    this.turn = 'idle'
    this.pendingPrompt = false
    this.settleAssistantRow('cancelled')
    for (const entry of this.entries) {
      if (entry.kind === 'request' && entry.state === 'pending') entry.state = 'cancelled'
    }
    this.flushStreamNotify()
    this.sinks.changed()
  }

  /**
   * 应用一次 assistant-stream 推送。
   *
   * 变的只有该行的文本：`session.stream` 已经把每个 delta 送到了活着的页面上，每来一个 token
   * 就重推整条时间线会把 port 淹掉。worker 这份副本照样跟着文本走，这样轮次中途打开的页面能
   * 重绘出到目前为止收到的东西。
   * @param event - 已经转发给页面的规整流式事件。
   */
  applyStream(event: AssistantStreamEvent): void {
    const frame = streamFrame(event)
    if (frame === undefined) return
    if (event.kind === 'snapshot') {
      // 对正在进行的那次尝试，基线说了算：直接换掉实时后缀，这样中途打开的页面永远不会显示
      // 一截攒了一半的前缀。
      this.attemptText = baselineText(frame.baseline)
      this.refreshAssistantRow()
      return
    }
    if (frame.type === 'start') {
      this.attemptText = ''
      this.refreshAssistantRow()
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!isRecord(chunk) || chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return
    this.attemptText += chunk.text
    this.refreshAssistantRow()
  }

  /**
   * 把一条持久会话事件落到轮次标志和助手行上。
   * @param event - 原始 `session/event` payload 事件。
   */
  applyEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== 'string') return
    switch (event.type) {
      case 'turn/start':
        this.startTurn()
        return
      case 'turn/end':
        this.endTurn()
        return
      case 'assistant/message': {
        const text = assistantMessageText(event)
        if (text === undefined) return
        // 持久消息把流里已经显示过的内容又给了一遍。把它当本步骤的权威文本提交，实时后缀
        // 就不显示了。
        if (this.committedText.at(-1) !== text) this.committedText.push(text)
        this.attemptText = ''
        // 已经合并但没发的流式更新一并丢掉：下面那行权威内容会取代它，留在待处理状态只会稍后
        // 把同一段文本再画一遍。
        this.flushStreamNotify()
        this.refreshAssistantRow(true)
        return
      }
      default:
        return
    }
  }

  /**
   * 把一次工具或命令运行加进时间线。
   * @param callId - 和对应 `ActivityEntry` 共用的 id。
   * @param tool - 工具名，比如 `browser_click`。
   * @param text - 这次运行的安全显示摘要。
   */
  addStep(callId: string, tool: string, text: string): void {
    const index = this.stepIndex(callId)
    if (index === -1) {
      this.push({
        id: newId('step'),
        kind: 'step',
        text,
        tool,
        state: 'pending',
        at: Date.now(),
        callId,
      })
      this.sinks.changed()
      return
    }
    const current = this.entries[index]!
    if (current.text === text && current.tool === tool) return
    this.entries[index] = { ...current, text, tool }
    this.sinks.changed()
  }

  /** 浏览器这边真开工了；还在排队的步骤现在转成运行中。 */
  startStep(callId: string): void {
    const index = this.stepIndex(callId)
    if (index === -1) return
    const current = this.entries[index]!
    if (current.state !== 'pending') return
    this.entries[index] = { ...current, state: 'running' }
    this.sinks.changed()
  }

  /** 把一次活动状态变化镜像到它的步骤行上（没有这行就建一个）。 */
  applyActivity(entry: ActivityEntry): void {
    const index = this.stepIndex(entry.id)
    if (index === -1) {
      this.push({
        id: newId('step'),
        kind: 'step',
        text: entry.summary,
        tool: entry.name,
        state: entry.state,
        at: entry.at,
        callId: entry.id,
      })
      this.sinks.changed()
      return
    }
    const current = this.entries[index]!
    if (current.text === entry.summary && current.state === entry.state && current.tool === entry.name) return
    this.entries[index] = { ...current, text: entry.summary, tool: entry.name, state: entry.state }
    this.sinks.changed()
  }

  private resetTurnText(): void {
    this.committedText = []
    this.attemptText = ''
    this.assistantRowId = null
  }

  private assistantText(): string {
    return [...this.committedText, this.attemptText]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n')
  }

  /**
   * 建出或更新本轮唯一那行助手行。
   *
   * 已有的行只改文本：状态归本轮管，所以一条迟到的持久消息救不活一个 `turn/end` 已经结算过的
   * 行。
   * @param notify - 行已经存在也强制重绘。
   */
  private refreshAssistantRow(notify = false): void {
    const text = this.assistantText()
    if (text === '') return
    if (this.assistantRowId !== null) {
      const index = this.entries.findIndex((entry) => entry.id === this.assistantRowId)
      if (index !== -1) {
        const current = this.entries[index]!
        if (current.text === text) {
          if (notify) this.sinks.changed()
          return
        }
        this.entries[index] = { ...current, text }
        if (notify) this.sinks.changed()
        else this.scheduleStreamNotify()
        return
      }
      // 这一行被上限挤掉了；下次更新会另起一行。
      this.assistantRowId = null
    }
    const entry: TimelineEntry = {
      id: newId('assistant'),
      kind: 'assistant',
      text,
      // 活跃轮次之外到的文本（`turn/end` 之后送来的持久消息）已经是最终态了。
      state: this.turn === 'running' ? 'running' : 'done',
      at: Date.now(),
    }
    this.assistantRowId = entry.id
    this.push(entry)
    if (notify) this.sinks.changed()
    else this.scheduleStreamNotify()
  }

  /**
   * 每 {@link STREAM_NOTIFY_MS} 最多发一次流式更新。
   *
   * 每次发布都要克隆整段助手文本、再通过 port 发出去，而一次回复每秒能产出几百个 delta，所以
   * 照着 delta 通知会让跨进程开销随回复长度平方增长。合并之后该行照样同步，开销却变成线性的。
   * 用普通定时器，不用 animation frame：这段代码跑在 service worker 里，那儿不保证帧回调送得到。
   */
  private scheduleStreamNotify(): void {
    if (this.streamNotifyTimer !== null) return
    this.streamNotifyTimer = setTimeout(() => {
      this.streamNotifyTimer = null
      this.sinks.changed()
    }, STREAM_NOTIFY_MS)
  }

  /** 把已经合并的流式更新立刻发出去；轮次结算时用。 */
  private flushStreamNotify(): void {
    if (this.streamNotifyTimer === null) return
    clearTimeout(this.streamNotifyTimer)
    this.streamNotifyTimer = null
    this.sinks.changed()
  }

  /** 给本轮的助手行收尾——得有这么一行、而且没被上限挤掉。 */
  private settleAssistantRow(state: 'done' | 'cancelled'): void {
    if (this.assistantRowId === null) return
    const index = this.entries.findIndex((entry) => entry.id === this.assistantRowId)
    if (index === -1) return
    const current = this.entries[index]!
    if (current.state !== state) this.entries[index] = { ...current, state }
  }

  private stepIndex(callId: string): number {
    return this.entries.findIndex((entry) => entry.kind === 'step' && entry.callId === callId)
  }

  private updateRow(id: string, patch: Partial<TimelineEntry>): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    this.entries[index] = { ...this.entries[index]!, ...patch }
    return true
  }

  private push(entry: TimelineEntry): void {
    this.entries.push(this.attributed(entry))
    if (this.entries.length > TIMELINE_LIMIT) {
      this.entries.splice(0, this.entries.length - TIMELINE_LIMIT)
    }
  }
}
