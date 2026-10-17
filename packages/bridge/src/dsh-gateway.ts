/**
 * bridge 适配的那部分 dsh Host 服务的结构化子集：TypertGateway 的 wire 接缝、Connection
 * 的 fetch 处理器，以及能分辨版本差异的 wire-stream 打开逻辑。
 *
 * @module dsh-browser-crossplatform/src/dsh-gateway
 */

import type { HostRpcFailure } from './host-api.ts'

/** dsh 0.2 的 Host TypertGateway 服务的结构化子集。 */
export interface TypertGatewayLike {
  readonly wireStream: {
    /**
     * dsh 0.2 的形态：`(endpoint, payload, uplink, peer, signal)`。
     * 旧版 stub/测试：`(endpoint, payload, signal)`。
     */
    open(
      endpoint: string,
      payload: unknown,
      uplinkOrSignal: AsyncIterable<unknown> | AbortSignal,
      peer?: unknown,
      signal?: AbortSignal,
    ): Promise<AsyncIterable<unknown>>
    failure(error: unknown): HostRpcFailure
  }
  invoke(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<unknown>
}

/**
 * Host 授予一个已认证调用方的 Peer 的运行时子集。
 *
 * dsh 0.2.x 的 `$events` 和 Remote 流会读 `peer.signal` / `peer.principal`，
 * 五参数形态下必须给一个真的 Peer。传 undefined 的表现是
 * `hello.ok` → `stream-failed: Cannot read properties of undefined (reading 'signal')` → WS 1011，
 * 扩展于是反复重连、面板永远停在「未连接」。
 */
export interface PeerLike {
  readonly signal: AbortSignal
  readonly principal: { readonly kind: string }
  readonly interactions: string
  dispose?(): Promise<void> | void
}

/**
 * 给进程内 Host wireStream.open 调用用的空 Client→Host 上行。
 * dsh 0.2 要求把这个 uplink 槽位填上；Gateway 自有的端点（$events）会立刻把它丢掉，
 * 而 Remote 流仍然要一个合法的 AsyncIterable。
 */
const EMPTY_WIRE_UPLINK: AsyncIterable<unknown> = {
  async *[Symbol.asyncIterator]() { /* 没有任何上行条目要发 */ },
}

/**
 * 按 dsh 0.2 或旧版三参数形式打开一条 Host wire 流。
 *
 * - 参数个数 3：composition/单元测试的 stub 还在用 `(endpoint, payload, signal)`。
 * - 参数个数 5：真正的 dsh 0.2 TypertGatewayWireStream。
 * - 参数个数 0：Cordis/服务包装层——必须按五参数调。把它们当成三参数，就会把
 *   AbortSignal 映射到 uplink 上，signal 变成 undefined，
 *   最终表现为（hello.ok → stream-failed → WS 1011）。
 *
 * @param peer - 五参数形态下调用方所属的 Peer；Host 的 `$events` 没有它就会抛。
 */
export function openWireStream(
  gateway: TypertGatewayLike,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer?: PeerLike,
): Promise<AsyncIterable<unknown>> {
  const open = gateway.wireStream.open
  if (open.length === 3) {
    return open(endpoint, payload, signal)
  }
  return open(endpoint, payload, EMPTY_WIRE_UPLINK, peer, signal)
}

/** 一条 wire 流要用的 Peer，连同它的释放。 */
export interface WirePeer {
  readonly peer: PeerLike | undefined
  dispose(): Promise<void>
}

/**
 * 取一个可用于进程内 wire 流的 Peer。
 *
 * 优先让连接服务为本进程造一个 owner Peer；旧宿主没有 `createPeer` 时退回复用共享的
 * `browserPeer`（它归连接服务所有，这里不释放）。都没有就返回 undefined，交给
 * 三参数形态的宿主——那种宿主本来也不看 peer。
 *
 * @param connection - 插件读到的 Connection 服务。
 * @returns Peer 句柄；`dispose` 只会释放自己创建的 Peer。
 */
export function createWirePeer(connection: HostConnectionLike): WirePeer {
  const createPeer = connection.createPeer
  if (typeof createPeer === 'function') {
    const peer = createPeer.call(connection, { principal: { kind: 'owner' } })
    return {
      peer,
      dispose: async () => { await peer.dispose?.() },
    }
  }
  return { peer: connection.browserPeer, dispose: async () => {} }
}

/** dsh 0.2 的 Host Connection 服务的结构化子集。 */
export interface HostConnectionLike {
  createSharedFetchHandler(channel: '/api'): {
    fetch(request: Request): Promise<Response>
  }
  /**
   * 为本进程内的调用方造一个 owner Peer（dsh 0.2.x）。
   * 旧宿主没有这个方法；那时回退到共享的 {@link browserPeer}。
   */
  createPeer?(options: { principal: { kind: 'owner' }; interactions?: 'answer' }): PeerLike
  /** 浏览器连接共享的那个 owner Peer，只读借用。 */
  readonly browserPeer?: PeerLike
}
