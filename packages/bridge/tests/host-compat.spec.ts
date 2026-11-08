import { describe, expect, it, vi } from 'vitest'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from '../src/remote-host-api.ts'
import type { PeerLike } from '../src/dsh-gateway.ts'
import type { HostRpcCall } from '../src/host-api.ts'

/**
 * 宿主世代兼容性。
 *
 * bridge 面向的是 dsh 0.2.x 这一条线（peerDependencies 写的是 `>=0.2.0-rc.2 <0.3.0`），
 * 而这条线上 Peer 的契约变了两次：
 *
 * - 0.2.0-rc.2：Connection 既没有 `createPeer` 也没有 `browserPeer`，Gateway 的
 *   `prepareInvocation` 用 `request.peer ?? this.operatorPeer()` 兜底。没有 Peer 也能用。
 * - 0.2.1-alpha.5 起：Connection 长出 `createPeer`/`browserPeer`，同时 Gateway 的
 *   `prepareInvocation` 第一行变成 `assertPeerLive(request.peer, endpoint)`，直接读
 *   `peer.signal`——不再兜底。不传 Peer 就是
 *   `Cannot read properties of undefined (reading 'signal')`，面板「已连接」而对话全废。
 *
 * 这里把三代宿主的接缝都摆出来跑同一个 `RemoteHostApi`：桥接必须三代都能用，而不是
 * 只在开发机上那一版能用。
 */

function call(method: string, payload: unknown, rpcId = 'rpc-1'): HostRpcCall {
  return { rpcId, method, payload, signal: new AbortController().signal }
}

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

function makePeer(dispose = vi.fn()): PeerLike {
  return {
    signal: new AbortController().signal,
    principal: { kind: 'owner' },
    interactions: 'answer',
    dispose,
  }
}

type Era = '0.2.0-rc.2' | '0.2.1+' | 'browserPeer-only'

/**
 * 一套宿主接缝：`invoke` 按世代实现 Peer 规则，`open` 按 endpoint 给出真实的业务帧。
 *
 * 三个 endpoint 的帧形状取自真实 Gateway 的 Remote 流：
 * `$events` 先给 `ready`，`workspace/follow` 先给 `baseline`，`session/follow` 先给
 * `snapshot` 并带一个可用的历史游标。
 */
function host(era: Era) {
  const operator = makePeer()
  const dispose = vi.fn()
  const peer = makePeer(dispose)

  const business = (method: string): unknown => {
    switch (method) {
      case 'modelCatalog':
        return {
          default: { provider: 'deepseek-official', model: 'deepseek-flash' },
          routableProviders: ['deepseek-official'],
          groups: [],
          failures: [],
        }
      case 'projections':
        return { asOfSeq: 1, values: { modelSelection: { next: null } } }
      case 'list':
        return { sessions: [] }
      case 'page':
        return { records: [], hasMore: false }
      default:
        throw new Error(`Unexpected method: ${method}`)
    }
  }

  /** 0.2.0-rc.2：没有 Peer 就用 operator Peer；0.2.1+：读 `peer.signal`，没有就抛。 */
  const invoke = vi.fn(async (request: { method: string; peer?: PeerLike }) => {
    let effective: PeerLike
    if (era === '0.2.0-rc.2') {
      effective = request.peer ?? operator
    } else {
      // 这就是 `assertPeerLive` 的真实失败方式：直接读 `peer.signal`。
      const peer = request.peer
      if (peer?.signal === undefined) {
        throw new TypeError("Cannot read properties of undefined (reading 'signal')")
      }
      effective = peer
    }
    expect(effective.signal).toBeDefined()
    return business(request.method)
  })

  const open = vi.fn(async (endpoint: string, _payload: unknown, _uplink: AsyncIterable<unknown>, _peer: unknown, signal: AbortSignal) => {
    // 五参数形态：真实 Gateway 的 `wireStream.open` 在所有 0.2.x 版本里都是五参。
    return {
      async *[Symbol.asyncIterator]() {
        if (endpoint === '$events') yield { type: 'ready', clientId: 'test', host: {} }
        else if (endpoint === 'workspace/follow') yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        else if (endpoint === 'session/follow') yield { type: 'snapshot', cursor: 5, records: [], hasMore: false }
        await abortWait(signal)
      },
    }
  })

  const connection: HostConnectionLike = {
    createSharedFetchHandler: () => ({
      fetch: async () => Response.json({ type: 'server-response', rpcId: 'unused', result: { ok: true } }),
    }),
    ...(era === '0.2.0-rc.2' ? {} : era === 'browserPeer-only'
      ? { browserPeer: peer }
      : { createPeer: vi.fn(() => peer) }),
  }

  const gateway: TypertGatewayLike = {
    invoke,
    wireStream: {
      open,
      failure: (error: unknown) => {
        const value = error as { code?: unknown; message?: unknown; details?: unknown }
        return {
          code: typeof value.code === 'string' ? value.code : 'internal',
          message: typeof value.message === 'string' ? value.message : String(error),
          details: typeof value.details === 'object' && value.details !== null ? value.details : {},
        }
      },
    },
  }

  return { api: createRemoteHostApi(gateway, connection), invoke, open, peer, dispose }
}

describe('host generations across the dsh 0.2 line', () => {
  it('works on 0.2.0-rc.2, where Connection has no Peer to offer and the Gateway falls back', async () => {
    // 这一代宿主既不提供 createPeer，也不提供 browserPeer：bridge 只能空手去调，
    // 由 Gateway 的 `request.peer ?? operatorPeer()` 兜底。若哪天有人「顺手」把
    // undefined 当成错误处理，这里会先红。
    const { api, invoke } = host('0.2.0-rc.2')
    await expect(api.call(call('session.models', { sessionId: 'session-1' }))).resolves.toMatchObject({ ok: true })
    await expect(api.call(call('session.list', {}))).resolves.toMatchObject({ ok: true })
    await expect(api.call(call('workspace.list', {}))).resolves.toMatchObject({ ok: true })
    await expect(api.call(call('session.history', { sessionId: 'session-1' }))).resolves.toMatchObject({ ok: true })
    // 桥接确实送的是 undefined，而不是自己编一个 Peer 出来。
    for (const [request] of invoke.mock.calls) expect((request as { peer?: unknown }).peer).toBeUndefined()
  })

  it('works on 0.2.1+, where prepareInvocation reads request.peer.signal and has no fallback', async () => {
    // 0.2.1-alpha.5 起 `assertPeerLive` 成为 prepareInvocation 的第一行。少了 Peer，
    // 每一个 unary 调用都会以 `Cannot read properties of undefined (reading 'signal')`
    // 失败——这正是 BUG-008 的现场。
    const { api, invoke, peer, dispose } = host('0.2.1+')
    await expect(api.call(call('session.models', { sessionId: 'session-1' }))).resolves.toMatchObject({ ok: true })
    await expect(api.call(call('session.list', {}))).resolves.toMatchObject({ ok: true })
    await expect(api.call(call('workspace.list', {}))).resolves.toMatchObject({ ok: true })
    await expect(api.call(call('session.history', { sessionId: 'session-1' }))).resolves.toMatchObject({ ok: true })
    // modelCatalog + projections + session/list；workspace.list 与 session.history 走 wire 流。
    expect(invoke.mock.calls.length).toBe(3)
    for (const [request] of invoke.mock.calls) expect((request as { peer?: unknown }).peer).toBe(peer)
    await api.dispose?.()
    // 这个 Peer 是 Connection 的 createPeer 造的，插件拥有它，卸载时必须释放。
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('borrows the shared browserPeer on the 0.2.1 host that predates createPeer', async () => {
    const { api, invoke, open, peer, dispose } = host('browserPeer-only')
    await expect(api.call(call('session.models', { sessionId: 'session-1' }))).resolves.toMatchObject({ ok: true })
    await expect(api.call(call('workspace.list', {}))).resolves.toMatchObject({ ok: true })
    for (const [request] of invoke.mock.calls) expect((request as { peer?: unknown }).peer).toBe(peer)

    const controller = new AbortController()
    const iterator = api.events(controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(open).toHaveBeenCalledWith('$events', expect.anything(), expect.anything(), peer, expect.any(AbortSignal)) })
    controller.abort()
    await pending.catch(() => undefined)
    await api.dispose?.()
    // 共享 Peer 归 Connection 服务所有：插件释放它 = 把整台桌面的浏览器连接一起踢掉。
    expect(dispose).not.toHaveBeenCalled()
  })

  it('keeps the five-argument wire-stream call for every host generation', async () => {
    // 三代宿主的 `wireStream.open` 都是五参；参数个数为 3 只是旧 stub 的形态。
    // 这里顺带守住「参数个数判断」本身：空参的可调用对象(Cordis 包装)也必须走五参。
    for (const era of ['0.2.0-rc.2', '0.2.1+', 'browserPeer-only'] as const) {
      const { api, open } = host(era)
      await api.call(call('workspace.list', {}))
      expect(open.mock.calls[0]?.[0]).toBe('workspace/follow')
      expect(open.mock.calls[0]?.length).toBe(5)
      expect(open.mock.calls[0]?.[4]).toBeInstanceOf(AbortSignal)
    }
  })
})
