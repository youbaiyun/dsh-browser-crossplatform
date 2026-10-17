/**
 * dsh 0.2 Host 适配器：unary 调用走 TypertGateway，Session 和转发事件管道则由 gateway、
 * history、event-generation 三个模块拼起来。
 *
 * @module dsh-browser-crossplatform/src/remote-host-api
 */

import type { RespondResult } from '@dsh-browser/protocol'
import type {
  BrowserHostApi,
  HostEventFrame,
  HostRpcCall,
  HostRpcFailure,
  HostRpcResult,
} from './host-api.ts'
import { hostFailure, isRecord } from './host-api.ts'
import { ExtensionSessionRegistry } from './extension-sessions.ts'
import { openWireStream, type TypertGatewayLike, type HostConnectionLike } from './dsh-gateway.ts'
import {
  oneShotSessionSnapshot,
  historyValue,
  historyPageValue,
  optionalNonNegativeInteger,
  optionalPositiveInteger,
} from './session-history.ts'
import { EventGeneration, type RemoteEventOutcome } from './event-generation.ts'


interface InvokeTarget {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly adapt?: (value: unknown) => unknown
}


/** 构造 dsh 0.2 的 Host 实现。 */
export function createRemoteHostApi(
  gateway: TypertGatewayLike,
  connection: HostConnectionLike,
): BrowserHostApi {
  return new RemoteHostApi(gateway, connection)
}

class RemoteHostApi implements BrowserHostApi {
  private readonly fetchHandler: ReturnType<HostConnectionLike['createSharedFetchHandler']>
  private readonly extensionSessions = new ExtensionSessionRegistry()
  /** 每个 Session 已知的最后 session/follow 顶端；用来驱动 session/page 的 throughSeq。 */
  private readonly historyCursors = new Map<string, number>()
  private activeEvents: EventGeneration | undefined

  constructor(
    private readonly gateway: TypertGatewayLike,
    connection: HostConnectionLike,
  ) {
    this.fetchHandler = connection.createSharedFetchHandler('/api')
  }

  async call(call: HostRpcCall): Promise<HostRpcResult> {
    if (call.method === 'session.history') return this.sessionHistory(call)
    if (call.method === 'session.models') return this.sessionModels(call)
    if (call.method === 'workspace.list') return this.workspaceList(call)
    if (call.method === 'session.follow') return this.sessionFollow(call)
    if (call.method === 'session.unfollow') return this.sessionUnfollow(call)

    const target = invokeTarget(call)
    if ('error' in target) return { ok: false, error: target.error }

    try {
      // 被延迟的 Session 没有 history 调用可以拿来建 follower。要在它创建之后、
      // 接纳 prompt 之前把 follower 打开，这样最早的 user/turn 事件
      // 才不会抢在扩展前面溜掉。
      if (call.method === 'session.prompt') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId !== undefined) await this.activeEvents?.ensureSessionFollow(sessionId, call.signal)
      }
      const value = await this.gateway.invoke({
        namespace: target.namespace,
        method: target.method,
        args: target.args,
        signal: call.signal,
      })
      // 只在 create/prompt 成功之后才认领所有权。针对桌面 session 的失败 prompt
      // 绝不能把后面的 ask_user_question
      // 从原生 waterfall 手里抢走。
      if (call.method === 'session.create' || call.method === 'session.prompt') {
        this.extensionSessions.note(sessionIdOf(call.payload))
        this.extensionSessions.note(sessionIdOf(value))
        if (typeof value === 'string') this.extensionSessions.note(value)
      }
      return { ok: true, value: target.adapt?.(value) ?? value }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  async *events(signal: AbortSignal): AsyncIterable<HostEventFrame> {
    const generation = new EventGeneration(
      this.gateway,
      this.sendRemoteEventResult.bind(this),
      this.extensionSessions,
      this.noteHistoryCursor.bind(this),
      signal,
    )
    const previous = this.activeEvents
    this.activeEvents = generation
    await previous?.dispose()
    generation.start()
    try {
      yield * generation.events()
    } finally {
      if (this.activeEvents === generation) this.activeEvents = undefined
      await generation.dispose()
    }
  }

  async respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown> {
    const generation = this.activeEvents
    if (generation === undefined) return { accepted: false, reason: 'not-pending' }
    return generation.respond(rpcId, result, signal)
  }

  private async sessionHistory(call: HostRpcCall): Promise<HostRpcResult> {
    const sessionId = sessionIdOf(call.payload)
    if (sessionId === undefined) return badRequest('session.history requires a non-empty sessionId')
    let beforeSeq: number | undefined
    let maxMessages: number | undefined
    try {
      beforeSeq = optionalNonNegativeInteger(call.payload, 'beforeSeq')
      maxMessages = optionalPositiveInteger(call.payload, 'maxMessages')
    } catch (error: unknown) {
      return badRequest(error instanceof Error ? error.message : 'session.history pagination is invalid')
    }
    try {
      if (beforeSeq !== undefined) {
        const throughSeq = await this.historyThroughSeq(sessionId, call.signal)
        const page = await this.gateway.invoke({
          namespace: 'session',
          method: 'page',
          args: {
            request: {
              address: { kind: 'session', sessionId },
              throughSeq,
              beforeSeq,
              ...(maxMessages === undefined ? {} : { maxMessages }),
            },
          },
          signal: call.signal,
        })
        return { ok: true, value: historyPageValue(page) }
      }

      const snapshot = this.activeEvents === undefined
        ? await oneShotSessionSnapshot(this.gateway, sessionId, call.signal, maxMessages)
        : await this.activeEvents.openSessionHistory(sessionId, call.signal, maxMessages)
      this.noteHistoryCursor(sessionId, snapshot.cursor)
      return { ok: true, value: historyValue(snapshot) }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * 不让它发提示，只管把某个 Session 的事件推给扩展。
   *
   * `session.prompt` 会顺带打开 follower，自己发提示的面板之所以能看见自己那段对话，靠的
   * 就是这个。而一个只是在*观看*桌面应用驱动的那段对话的面板没有提示可发，没有这个调用
   * 它就什么都收不到：扩展的渲染层会丢掉所有 sessionId 与它绑定的那个对不上的事件，而
   * 没有任何东西把它绑到一个正在运行的 Session 上。
   *
   * 从构造上就是只读的——它打开的 follower 和 `session.history` 会打开的完全一样，也不
   * 返回任何 Session 值——所以它既改不了 Session 的状态，也接纳不了一个 turn。
   *
   * @param call - Host 调用；`sessionId` 指定要跟随的 Session。
   * @returns `{ following: true }`，或 bad-request/gateway 失败。
   */
  private async sessionFollow(call: HostRpcCall): Promise<HostRpcResult> {
    const sessionId = sessionIdOf(call.payload)
    if (sessionId === undefined) return badRequest('session.follow requires a non-empty sessionId')
    if (this.activeEvents === undefined) {
      return {
        ok: false,
        error: this.failure(new Error('this deployment cannot stream Session events')),
      }
    }
    try {
      await this.activeEvents.ensureSessionFollow(sessionId, call.signal)
      return { ok: true, value: { following: true } }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * 停止读取指定之外的所有 Session，并把它们的流放掉。
   *
   * 它是 {@link sessionFollow} 的对立面，也是让整个工作区镜像不至于在连接活着的整段时间
   * 里为每段对话各攥一条流的东西。调用方声明的是它还在看什么，不是要关掉什么：它手里的
   * 集合才算数，所以就算扩展漏掉了一次状态变化，最后留下来的也恰好是它想要的那些流；
   * 指定一个它没在跟随的 Session 只是空操作，不是错误。
   *
   * 和 `session.follow` 一样是只读的——它只是停止读取。
   *
   * @param call - Host 调用；`keep` 列出仍然需要的 Session id。
   * @returns `{ following: n }`，即仍在被读取的 Session 数。
   */
  private sessionUnfollow(call: HostRpcCall): HostRpcResult {
    if (!isRecord(call.payload)) return badRequest('session.unfollow payload must be an object')
    const raw = call.payload.keep
    if (raw !== undefined && !Array.isArray(raw)) {
      return badRequest('session.unfollow keep must be an array of session ids')
    }
    const keep = new Set<string>()
    for (const entry of Array.isArray(raw) ? raw : []) {
      // 格式不对的条目跳过，不让整个调用失败：这个请求的全部目的就是
      // 释放资源，拒掉它反而会让资源继续被占着。
      if (typeof entry === 'string' && entry !== '') keep.add(entry)
    }
    if (this.activeEvents === undefined) {
      return { ok: false, error: this.failure(new Error('this deployment cannot stream Session events')) }
    }
    try {
      this.activeEvents.retainSessionFollows(keep)
      return { ok: true, value: { following: keep.size } }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /** 把部署的目录与该 Session 持久化的下一项选择合并起来。 */
  private async sessionModels(call: HostRpcCall): Promise<HostRpcResult> {
    if (!isRecord(call.payload)) return badRequest('session.models payload must be an object')
    const sessionId = sessionIdOf(call.payload)
    try {
      const catalog = await this.gateway.invoke({
        namespace: 'session', method: 'modelCatalog', args: {}, signal: call.signal,
      })
      // 临时 Session 只要目录，再叠上自己那几项还没落定的选择。
      const projections = sessionId === undefined ? undefined : await this.gateway.invoke({
        namespace: 'session', method: 'projections', args: { request: { sessionId } }, signal: call.signal,
      })
      const values = isRecord(projections) ? projections.values : undefined
      const modelSelection = isRecord(values) ? values.modelSelection : undefined
      const next = isRecord(modelSelection) ? modelSelectionOf(modelSelection.next) : undefined
      return { ok: true, value: adaptModelCatalog(catalog, next) }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * 给更旧的历史分页算出一个 Host 认可的 throughSeq。
   * 绝不要凭空造一个 Number.MAX_SAFE_INTEGER——session/page 会拒绝越过日志游标顶端的值。
   */
  private async historyThroughSeq(sessionId: string, signal: AbortSignal): Promise<number> {
    const cached = this.historyCursors.get(sessionId)
    if (cached !== undefined) return cached
    const snapshot = this.activeEvents === undefined
      ? await oneShotSessionSnapshot(this.gateway, sessionId, signal)
      : await this.activeEvents.openSessionHistory(sessionId, signal)
    this.noteHistoryCursor(sessionId, snapshot.cursor)
    const throughSeq = this.historyCursors.get(sessionId)
    if (throughSeq === undefined) {
      throw new TypeError('session/follow snapshot did not provide a usable history cursor')
    }
    return throughSeq
  }

  private noteHistoryCursor(sessionId: string, cursor: number): void {
    // Host 的 session/page 会拒绝越过持久化顶端的 throughSeq；MAX_SAFE_INTEGER 在
    // 别处只是个 UI 哨兵值，绝不能当成分页顶端转发出去。
    if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor === Number.MAX_SAFE_INTEGER) return
    const previous = this.historyCursors.get(sessionId)
    if (previous === undefined || cursor > previous) this.historyCursors.set(sessionId, cursor)
  }

  private async workspaceList(call: HostRpcCall): Promise<HostRpcResult> {
    try {
      const controller = new AbortController()
      const signal = AbortSignal.any([call.signal, controller.signal])
      const source = await openWireStream(this.gateway, 'workspace/follow', { args: {} }, signal)
      const iterator = source[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        if (first.done || !isWorkspaceBaseline(first.value)) {
          throw new TypeError('workspace/follow did not begin with a baseline')
        }
        return { ok: true, value: first.value.value }
      } finally {
        controller.abort(new Error('workspace baseline received'))
        await iterator.return?.()
      }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  private failure(error: unknown): HostRpcFailure {
    try {
      return this.gateway.wireStream.failure(error)
    } catch {
      return hostFailure(error)
    }
  }

  private async sendRemoteEventResult(
    clientId: string,
    eventId: string,
    outcome: RemoteEventOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const rpcId = crypto.randomUUID()
    const request = new Request('http://dsh.internal/api/$events/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: '$events/result',
        payload: { args: { clientId, eventId, outcome } },
      }),
      signal,
    })
    const response = await this.fetchHandler.fetch(request)
    if (!response.ok) {
      throw new Error(`$events/result transport failed with HTTP ${String(response.status)}: ${await response.text()}`)
    }
    const envelope = await response.json() as unknown
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
      throw new TypeError('$events/result returned an invalid server-response')
    }
    if (envelope.result.ok) return
    const error = isRecord(envelope.result.error) ? envelope.result.error : {}
    const failure = new Error(typeof error.message === 'string' ? error.message : '$events/result was rejected') as Error & {
      code?: string
      details?: unknown
    }
    if (typeof error.code === 'string') failure.code = error.code
    if (error.details !== undefined) failure.details = error.details
    throw failure
  }
}


function invokeTarget(call: HostRpcCall): InvokeTarget | { readonly error: HostRpcFailure } {
  if (!isRecord(call.payload)) return { error: badRequestFailure(`${call.method} payload must be an object`) }
  switch (call.method) {
    case 'session.list':
      return { namespace: 'session', method: 'list', args: { _request: call.payload } }
    case 'session.create':
    case 'session.selectModel':
    case 'session.attachment':
    case 'session.cancel':
    case 'workspace.create':
    case 'workspace.rename':
    case 'workspace.archiveSession': {
      const [namespace, method] = call.method.split('.') as [string, string]
      return { namespace, method, args: { request: call.payload } }
    }
    case 'session.prompt':
      return {
        namespace: 'session',
        method: 'prompt',
        args: { request: { requestId: call.rpcId, ...call.payload } },
      }
    case 'settings.describe':
      return { namespace: 'settings', method: 'describe', args: {} }
    case 'settings.mutate':
      return { namespace: 'settings', method: 'mutate', args: call.payload }
    case 'credentials.describe':
      return {
        namespace: 'credentials',
        method: 'describe',
        args: call.payload,
        adapt: value => ({ credentials: value }),
      }
    case 'credentials.set':
    case 'credentials.unset': {
      const method = call.method.slice('credentials.'.length)
      return { namespace: 'credentials', method, args: call.payload, adapt: () => ({}) }
    }
    case 'llm.discoverModels': {
      const { settingsNs, ...request } = call.payload
      if (typeof settingsNs !== 'string' || settingsNs.length === 0) {
        return { error: badRequestFailure('llm.discoverModels requires settingsNs') }
      }
      return {
        namespace: 'llm',
        method: 'discoverModels',
        args: { settingsNs, request },
        adapt: value => ({ models: value }),
      }
    }
    default:
      return {
        error: {
          code: 'not-found',
          message: `browser bridge Host method ${JSON.stringify(call.method)} is unavailable`,
          details: {},
        },
      }
  }
}


function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return typeof payload.sessionId === 'string' && payload.sessionId.length > 0
    ? payload.sessionId
    : undefined
}

/** 把 Host ModelCatalog 映射成扩展的 session.models 目录形状。 */
function adaptModelCatalog(value: unknown, next?: ReturnType<typeof modelSelectionOf>): unknown {
  if (!isRecord(value)) return value
  const selection = next ?? modelSelectionOf(value.default)
  const groups = Array.isArray(value.groups) ? value.groups : []
  const failures = Array.isArray(value.failures) ? value.failures : []
  const routableProviders = Array.isArray(value.routableProviders)
    ? value.routableProviders.filter((entry): entry is string => typeof entry === 'string')
    : []
  const current = selection ?? { provider: 'none', model: 'none' }
  return {
    current,
    routable: selection !== undefined && routableProviders.includes(selection.provider),
    groups,
    failures,
  }
}

function modelSelectionOf(value: unknown): {
  provider: string
  model: string
  reasoningEffort?: string
} | undefined {
  if (!isRecord(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const reasoningEffort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() !== ''
    ? value.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function badRequest(message: string): HostRpcResult {
  return { ok: false, error: badRequestFailure(message) }
}

function badRequestFailure(message: string): HostRpcFailure {
  return { code: 'bad-request', message, details: {} }
}

function isWorkspaceBaseline(value: unknown): value is {
  readonly type: 'baseline'
  readonly value: Record<string, unknown>
} {
  return isRecord(value) && value.type === 'baseline' && isRecord(value.value)
}

