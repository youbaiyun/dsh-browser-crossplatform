/**
 * 一条已认证扩展连接名下的事件流、它当前活跃的 Session follower，以及它要应答的那些
 * 被转发的 Host waterfall。
 *
 * @module dsh-browser-crossplatform/src/event-generation
 */

import type { RespondResult } from '@dsh-browser/protocol'
import { openWireStream, type PeerLike, type TypertGatewayLike } from './dsh-gateway.ts'
import { isSessionSnapshot, type SessionSnapshot } from './session-history.ts'
import type { HostEventFrame } from './host-api.ts'
import { isRecord } from './host-api.ts'
import { ExtensionSessionRegistry, shouldBridgeOwnQuestion } from './extension-sessions.ts'

interface PendingQuestion {
  readonly sessionId: string
  settled: boolean
}

/**
 * 这条连接正在读取的一个 Session。
 *
 * 它自带的 abort controller 正是让各个 follower 彼此独立的东西：停掉其中一个——某个会话
 * 离开被镜像的集合，或者被顶替——都不能影响其它 follower。这里刻意不共享任何状态。
 */
interface SessionFollower {
  readonly controller: AbortController
}

export type SendRemoteEventResult = (
  clientId: string,
  eventId: string,
  outcome: RemoteEventOutcome,
  signal: AbortSignal,
) => Promise<void>

export type RemoteEventOutcome =
  | { readonly kind: 'next' }
  | { readonly kind: 'result'; readonly value?: unknown }
  | {
    readonly kind: 'rejected'
    readonly error: {
      readonly name: string
      readonly message: string
      readonly code?: string
      readonly details?: unknown
    }
  }

/** 一条已认证扩展连接的事件流及其 Session follower。 */
export class EventGeneration {
  private readonly lifetime = new AbortController()
  private readonly signal: AbortSignal
  private readonly queue = new AsyncEventQueue()
  private readonly tasks = new Set<Promise<void>>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private clientId: string | undefined
  /**
   * 每个 Session 一个 follower，用 Session id 做键。
   *
   * 用 map 而不是单个槽位：「工作区内」镜像的是整个工作区，只有一个槽位时，每次 follow
   * 都会中止前一个——于是十九个会话只有一条活跃流，另外十八条悄无声息。
   */
  private readonly followers = new Map<string, SessionFollower>()
  private disposed = false

  constructor(
    private readonly gateway: TypertGatewayLike,
    /** 这些流所属的 Peer；Host 的 `$events` 和 Remote 流会读它的 signal。 */
    private readonly peer: PeerLike | undefined,
    private readonly sendResult: SendRemoteEventResult,
    private readonly extensionSessions: ExtensionSessionRegistry,
    private readonly onHistoryCursor: (sessionId: string, cursor: number) => void,
    outerSignal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([outerSignal, this.lifetime.signal])
  }

  start(): void {
    this.track(this.pumpRemoteEvents())
  }

  events(): AsyncIterable<HostEventFrame> {
    return this.queue.iterate(this.signal)
  }

  async openSessionHistory(
    sessionId: string,
    callSignal: AbortSignal,
    maxMessages?: number,
  ): Promise<SessionSnapshot> {
    return this.openSessionFollow(sessionId, callSignal, maxMessages)
  }

  /**
   * 跟随一个 Session；这条连接还没在读它的话，就把它的流打开。
   *
   * 是**每个 Session** 一个 follower，不是每条连接一个。面板只镜像一个会话时，单个槽位
   * 够用；但「工作区内」镜像整个工作区：只有单个槽位时，每次 `session.follow` 都会中止
   * 上一个 follower，请求十九个会话只剩一条在推流，面板悄无声息地只显示十九个里的一个。
   *
   * 对同一个 Session 是幂等的，调用方可以反复请求——扩展就是这样，每个刷新周期请求一次。
   *
   * @param sessionId - 要读取的 Session。
   * @param callSignal - 调用方的取消信号。
   */
  async ensureSessionFollow(sessionId: string, callSignal: AbortSignal): Promise<void> {
    const existing = this.followers.get(sessionId)
    if (existing !== undefined && existing.controller.signal.aborted === false) return
    await this.openSessionFollow(sessionId, callSignal)
  }

  /**
   * 不再跟随不在给定集合里的那些 Session。
   *
   * 镜像集合缩小时调用——某个会话离开了工作区，或者用户切回了单会话模式——bridge 就不再
   * 读取没人在看的 Session，而不是整条连接活着的时候一直为它们推流。
   *
   * @param keep - 需要继续跟随的 Session。
   */
  retainSessionFollows(keep: ReadonlySet<string>): void {
    for (const [sessionId, follower] of [...this.followers]) {
      if (keep.has(sessionId)) continue
      this.followers.delete(sessionId)
      follower.controller.abort(new Error('browser bridge Session follower no longer watched'))
    }
  }

  async respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown> {
    const pending = this.pendingQuestions.get(rpcId)
    const clientId = this.clientId
    if (pending === undefined || pending.settled || clientId === undefined) {
      return { accepted: false, reason: 'not-pending' }
    }
    pending.settled = true
    try {
      await this.sendResult(clientId, rpcId, respondOutcome(result), AbortSignal.any([this.signal, signal]))
      return { accepted: true }
    } catch (error: unknown) {
      pending.settled = false
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const follower of this.followers.values()) {
      follower.controller.abort(new Error('browser bridge event generation closed'))
    }
    this.followers.clear()
    this.lifetime.abort(new Error('browser bridge event generation closed'))
    this.queue.end()
    await Promise.all(this.tasks)
  }

  private async openSessionFollow(
    sessionId: string,
    callSignal: AbortSignal,
    maxMessages?: number,
  ): Promise<SessionSnapshot> {
    // 只替换*这个 Session*已有的 follower。其它所有 Session 继续推流，
    // 整个工作区镜像正是靠这一点才成立。
    this.followers.get(sessionId)?.controller.abort(new Error('browser bridge Session follower reopened'))
    const controller = new AbortController()
    const follower: SessionFollower = { controller }
    this.followers.set(sessionId, follower)
    const signal = AbortSignal.any([this.signal, callSignal, controller.signal])
    /** 这个 follower 是否仍是该 Session 当前的那一个。 */
    const current = (): boolean => this.followers.get(sessionId) === follower
    try {
      const source = await openWireStream(this.gateway,
        'session/follow',
        {
          args: {
            request: {
              address: { kind: 'session', sessionId },
              assistantStream: true,
              ...(maxMessages === undefined ? {} : { maxMessages }),
            },
          },
        },
        signal,
        this.peer,
      )
      const iterator = source[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done || !isSessionSnapshot(first.value)) {
        await iterator.return?.()
        throw new TypeError('session/follow did not begin with a snapshot')
      }
      if (!current() || signal.aborted) {
        await iterator.return?.()
        signal.throwIfAborted()
        throw new Error('browser bridge Session follower was replaced while opening')
      }
      this.onHistoryCursor(sessionId, first.value.cursor)
      const snapshotId = first.value.assistantStream === undefined ? undefined : crypto.randomUUID()
      // 先发重连前缀，再发后面任何分块。否则 RPC 响应和推送事件可能抢起来，
      // 面板重开历史时就丢掉某个已经在跑的尝试的开头。
      if (first.value.assistantStream !== undefined) {
        this.queue.push({
          rpcId: crypto.randomUUID(),
          method: 'session/assistant-stream',
          payload: {
            sessionId,
            snapshotId,
            frame: { type: 'snapshot', baseline: first.value.assistantStream },
          },
        })
      }
      this.track(this.pumpSessionEvents(sessionId, follower, iterator, signal))
      return {
        cursor: first.value.cursor,
        records: first.value.records,
        hasMore: first.value.hasMore,
        ...(first.value.projections === undefined ? {} : { projections: first.value.projections }),
        ...(first.value.assistantStream === undefined ? {} : { assistantStream: first.value.assistantStream }),
        ...(snapshotId === undefined ? {} : { snapshotId }),
      }
    } catch (error: unknown) {
      // 只删这个 Session 的条目，而且只在它仍然归我们时：一个已经被更新的 follower
      // 顶替掉的 follower，不能把继任者的注册删掉。
      if (current()) this.followers.delete(sessionId)
      throw error
    }
  }

  private async pumpSessionEvents(
    sessionId: string,
    follower: SessionFollower,
    iterator: AsyncIterator<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    /**
     * 这个 follower 是否仍是该 Session 当前的那一个。
     *
     * 由 follower 自己回答，绝不用整条连接共享的计数器。共享计数器会让其它每个 Session
     * 在新会话被跟随的那一刻就显得已经被替换，于是工作区镜像只剩一条流——和单个 abort
     * 槽位同样的故障，只是走了另一条路。
     */
    const current = (): boolean => this.followers.get(sessionId) === follower
    try {
      while (!signal.aborted) {
        const next = await iterator.next()
        // 对 AsyncIterator 来说 abort 只是建议性的：这个 follower 被顶替之后，某个已缓冲
        // 的帧仍可能 resolve。绝不能让那条已被取代的流去更新扩展里某个正由别人读取的
        // Session 的状态。
        if (signal.aborted || !current()) break
        if (next.done) break
        if (isRecord(next.value) && next.value.type === 'assistant-stream' && isRecord(next.value.frame)) {
          this.queue.push({
            rpcId: crypto.randomUUID(),
            method: 'session/assistant-stream',
            payload: { sessionId, frame: next.value.frame },
          })
          continue
        }
        if (!isSessionEventEntry(next.value)) {
          throw new TypeError('session/follow emitted an invalid incremental frame')
        }
        const seq = next.value.event.seq
        if (typeof seq === 'number') this.onHistoryCursor(sessionId, seq)
        this.queue.push({
          rpcId: crypto.randomUUID(),
          method: 'session/event',
          payload: { type: 'session/event', sessionId, event: next.value.event },
        })
      }
      if (!signal.aborted && current()) {
        throw new Error('session/follow ended unexpectedly')
      }
    } catch (error: unknown) {
      // 被刻意停掉的流——已被顶替，或不再被关注——不能让连接的队列报错：abort 是
      // 预期中的结果，不是故障。
      if (!signal.aborted && current()) this.queue.fail(error)
    } finally {
      await iterator.return?.()
      if (current()) this.followers.delete(sessionId)
    }
  }

  private async pumpRemoteEvents(): Promise<void> {
    try {
      const source = await openWireStream(this.gateway, '$events', { args: {} }, this.signal, this.peer)
      let ready = false
      for await (const value of source) {
        if (!ready) {
          if (!isRemoteEventReady(value)) throw new TypeError('$events did not begin with ready')
          this.clientId = value.clientId
          ready = true
          continue
        }
        await this.handleRemoteEvent(value)
      }
      if (!this.signal.aborted) throw new Error('$events ended unexpectedly')
    } catch (error: unknown) {
      if (!this.signal.aborted) this.queue.fail(error)
    }
  }

  private async handleRemoteEvent(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw new TypeError('$events emitted an invalid frame')
    }
    if (value.type === 'emit') return
    if (value.type === 'cancel' && typeof value.eventId === 'string') {
      const pending = this.pendingQuestions.get(value.eventId)
      if (pending === undefined) return
      this.pendingQuestions.delete(value.eventId)
      this.queue.push({
        rpcId: crypto.randomUUID(),
        method: 'question/resolved',
        payload: {
          type: 'question/resolved',
          sessionId: pending.sessionId,
          questionRpcId: value.eventId,
        },
      })
      return
    }
    if (value.type !== 'waterfall'
      || typeof value.event !== 'string'
      || typeof value.eventId !== 'string'
      || typeof value.agentId !== 'string'
      || !isRecord(value.request)) {
      throw new TypeError('$events emitted an invalid waterfall frame')
    }
    if (value.event !== 'user-questions/request' || !Array.isArray(value.request.questions)) {
      const clientId = this.clientId
      if (clientId !== undefined) {
        await this.sendResult(clientId, value.eventId, { kind: 'next' }, this.signal)
      }
      return
    }
    // 桌面端自有的 session 保留原生 waterfall。只有扩展成功创建、或成功发过提示的
    // session，才替它转发问题。
    if (!shouldBridgeOwnQuestion({
      hasExtensionConnection: true,
      sessionId: value.agentId,
      extensionSessions: this.extensionSessions,
    })) {
      const clientId = this.clientId
      if (clientId !== undefined) {
        await this.sendResult(clientId, value.eventId, { kind: 'next' }, this.signal)
      }
      return
    }
    this.pendingQuestions.set(value.eventId, { sessionId: value.agentId, settled: false })
    this.queue.push({
      rpcId: value.eventId,
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: value.agentId,
        questions: value.request.questions,
      },
    })
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => {
      if (!this.signal.aborted) this.queue.fail(error)
    })
    this.tasks.add(tracked)
    void tracked.finally(() => { this.tasks.delete(tracked) })
  }
}

class AsyncEventQueue {
  private readonly frames: HostEventFrame[] = []
  private wake: (() => void) | undefined
  private failure: unknown
  private closed = false

  push(frame: HostEventFrame): void {
    if (this.closed || this.failure !== undefined) return
    this.frames.push(frame)
    this.wake?.()
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) return
    this.failure = error
    this.wake?.()
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<HostEventFrame> {
    const onAbort = (): void => { this.wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.frames.length > 0) yield this.frames.shift() as HostEventFrame
        if (this.failure !== undefined) throw this.failure
        if (this.closed || signal.aborted) return
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function respondOutcome(result: RespondResult): RemoteEventOutcome {
  if (result.ok) {
    const value = isRecord(result.value) && isRecord(result.value.answer)
      ? result.value.answer
      : result.value
    return value === undefined ? { kind: 'result' } : { kind: 'result', value }
  }
  return {
    kind: 'rejected',
    error: {
      name: 'Error',
      message: result.error.message,
      code: result.error.code,
      details: result.error.details,
    },
  }
}

function isSessionEventEntry(value: unknown): value is {
  readonly type: 'event'
  readonly event: Record<string, unknown>
} {
  return isRecord(value) && value.type === 'event' && isRecord(value.event)
}

function isRemoteEventReady(value: unknown): value is {
  readonly type: 'ready'
  readonly clientId: string
} {
  return isRecord(value) && value.type === 'ready'
    && typeof value.clientId === 'string' && value.clientId.length > 0
}
