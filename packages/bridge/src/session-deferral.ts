/**
 * 把真正的 session 创建拖到第一次提示词。
 *
 * 面板一连上就会调 `session.create`，但一个被打开却从没用过的 session 不该在 store/GUI
 * 里留下任何痕迹。这个包装层用一个临时 id（本地生成、什么都不持久化）应答
 * `session.create`，对临时 id 的 `session.history` 返回空，并在该 id 第一次
 * `session.prompt` 时把真实 session 建出来——id 不变，创建载荷还是原来那份。被丢下的
 * 临时 id 会在 {@link PROVISIONAL_TTL_MS} 之后清掉。
 *
 * 临时 session 还会用宿主机全局的 `session.modelCatalog`（经 Host API 适配器，外加一个
 * 待定的切换）应答 `session.models`，并记住 `session.selectModel` 直到它真正被创建，
 * 这样输入区在第一条消息之前就能显示模型切换器。
 *
 * @module dsh-browser-crossplatform/src/session-deferral
 */

import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'

/** 比这个时长还老的临时条目，会在下一次 create 时丢掉。 */
const PROVISIONAL_TTL_MS = 30 * 60_000

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ProvisionalEntry {
  /** 原始的 create 载荷，创建时重放（保留 cwd/workspaceId）。 */
  payload: Record<string, unknown>
  createdAt: number
  /** 让失败的模型选择在 Host Session 建好之后还能重试。 */
  materialized?: boolean
  /** session 在 Host 上还不存在时，输入区选定的那个切换。 */
  selection?: ModelSelection
}

/**
 * 包装 gateway 的 sessions API，让 `session.create` 返回一个临时 id、什么都不真创建；
 * 真正的 session 到该 id 第一次 `session.prompt` 时才建出来。
 *
 * @param api - Gateway API 实现。
 * @param enabled - 是否启用延迟创建；为 false 时原样返回该 API。
 * @param imageLimits - 宿主机实际的图片能力，用来在被延迟的 Session 存在之前构造那份空的
 *   合成历史。
 * @returns 禁用时返回原 API，否则返回包装后的 API。
 */
export function withSessionDeferral(
  api: BrowserHostApi,
  enabled: boolean,
  imageLimits?: ImageAttachmentLimits,
): BrowserHostApi {
  if (!enabled) return api

  const provisional = new Map<string, ProvisionalEntry>()
  const materializing = new Map<string, Promise<HostRpcResult>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff && !entry.materialized && !materializing.has(id)) provisional.delete(id)
    }
  }

  const mintedId = (payload: Record<string, unknown>): string =>
    typeof payload.sessionId === 'string' ? payload.sessionId : `session-${crypto.randomUUID()}`

  async function materialize(sessionId: string, entry: ProvisionalEntry, signal: AbortSignal): Promise<HostRpcResult> {
    if (!entry.materialized) {
      const created = await api.call({
        rpcId: crypto.randomUUID(),
        method: 'session.create',
        payload: { ...entry.payload, sessionId },
        signal,
      })
      if (!created.ok) return created
      entry.materialized = true
    }
    // 所有提示共用这道屏障，包括在选择还没做完时到达的那些。
    // 改动过的选择也得先成功，排队的提示才会放行。
    while (entry.selection !== undefined) {
      const selection = entry.selection
      const selected = await api.call({
        rpcId: crypto.randomUUID(),
        method: 'session.selectModel',
        payload: { sessionId, ...selection },
        signal,
      })
      if (!selected.ok) return selected
      if (entry.selection === selection) delete entry.selection
    }
    provisional.delete(sessionId)
    return { ok: true, value: { sessionId } }
  }

  return {
    async call(call: HostRpcCall): Promise<HostRpcResult> {
      if (call.method === 'session.create') {
        if (!isRecord(call.payload)) {
          return { ok: false, error: { code: 'bad-request', message: 'session.create payload must be an object', details: {} } }
        }
        prune()
        const sessionId = mintedId(call.payload)
        provisional.set(sessionId, { payload: { ...call.payload }, createdAt: Date.now() })
        return { ok: true, value: { sessionId } }
      }
      if (call.method === 'session.history') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId === undefined || !provisional.has(sessionId)
          || provisional.get(sessionId)!.materialized) return api.call(call)
        return {
          ok: true,
          value: {
            events: [],
            hasMore: false,
            ...(imageLimits === undefined
              ? {}
              : { projections: { asOfSeq: -1, values: { imageLimits } } }),
          },
        }
      }
      if (call.method === 'session.models') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId === undefined || !provisional.has(sessionId)) return api.call(call)
        return provisionalModels(api, provisional.get(sessionId)!, call.signal)
      }
      if (call.method === 'session.selectModel') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId === undefined || !provisional.has(sessionId)) return api.call(call)
        const entry = provisional.get(sessionId)!
        const selected = selectionOf(call.payload)
        if (selected === undefined) {
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: 'session.selectModel requires provider and model',
              details: {},
            },
          }
        }
        entry.selection = selected
        return { ok: true, value: { selected: { ...selected } } }
      }
      if (call.method !== 'session.prompt') return api.call(call)
      const sessionId = sessionIdOf(call.payload)
      if (sessionId === undefined) return api.call(call)
      const entry = provisional.get(sessionId)
      if (entry === undefined) return api.call(call)
      const existing = materializing.get(sessionId)
      const pending = existing ?? materialize(sessionId, entry, call.signal)
      if (existing === undefined) {
        materializing.set(sessionId, pending)
        void pending.then(
          () => { materializing.delete(sessionId) },
          () => { materializing.delete(sessionId) },
        )
      }
      const created = await pending
      if (!created.ok) return created
      return api.call(call)
    },
    events: signal => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}

function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return typeof payload.sessionId === 'string' ? payload.sessionId : undefined
}

function selectionOf(payload: unknown): ModelSelection | undefined {
  if (!isRecord(payload)) return undefined
  const provider = typeof payload.provider === 'string' ? payload.provider.trim() : ''
  const model = typeof payload.model === 'string' ? payload.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const reasoningEffort = typeof payload.reasoningEffort === 'string' && payload.reasoningEffort.trim() !== ''
    ? payload.reasoningEffort.trim()
    : undefined
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** 给一个临时 id 从宿主 catalog 拼出一份 session.models 形状的答案。 */
async function provisionalModels(
  api: BrowserHostApi,
  entry: ProvisionalEntry,
  signal: AbortSignal,
): Promise<HostRpcResult> {
  // 用内层 API（不是延迟包装器）：session.models → session/modelCatalog。
  const catalog = await api.call({
    rpcId: crypto.randomUUID(),
    method: 'session.models',
    payload: {},
    signal,
  })
  if (!catalog.ok) return catalog
  const groups = isRecord(catalog.value) && Array.isArray(catalog.value.groups)
    ? catalog.value.groups
    : []
  const failures = isRecord(catalog.value) && Array.isArray(catalog.value.failures)
    ? catalog.value.failures
    : []
  const catalogCurrent = isRecord(catalog.value) ? modelSelectionOf(catalog.value.current) : undefined
  const current = entry.selection
    ?? catalogCurrent
    ?? await defaultSelection(api, signal)
    ?? firstCatalogSelection(groups)
  if (current === undefined) {
    return {
      ok: true,
      value: {
        current: { provider: 'none', model: 'none' },
        routable: false,
        groups,
        failures,
      },
    }
  }
  return {
    ok: true,
    value: {
      current: { ...current },
      routable: true,
      groups,
      failures,
    },
  }
}

function modelSelectionOf(value: unknown): ModelSelection | undefined {
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

async function defaultSelection(
  api: BrowserHostApi,
  signal: AbortSignal,
): Promise<ModelSelection | undefined> {
  const described = await api.call({
    rpcId: crypto.randomUUID(),
    method: 'settings.describe',
    payload: {},
    signal,
  })
  if (!described.ok || !isRecord(described.value) || !Array.isArray(described.value.namespaces)) {
    return undefined
  }
  const defaults = described.value.namespaces.find((candidate) => (
    isRecord(candidate) && candidate.ns === 'agent-default-model'
  ))
  const value = isRecord(defaults) && isRecord(defaults.value) ? defaults.value : undefined
  if (value === undefined) return undefined
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

function firstCatalogSelection(groups: unknown[]): ModelSelection | undefined {
  for (const group of groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || !Array.isArray(group.models)) continue
    for (const model of group.models) {
      if (!isRecord(model) || typeof model.id !== 'string' || model.id.trim() === '') continue
      return { provider: group.id, model: model.id }
    }
  }
  return undefined
}
