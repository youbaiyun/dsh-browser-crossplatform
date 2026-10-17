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
 */
export function openWireStream(gateway: TypertGatewayLike, endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  const open = gateway.wireStream.open
  if (open.length === 3) {
    return open(endpoint, payload, signal)
  }
  return open(endpoint, payload, EMPTY_WIRE_UPLINK, undefined, signal)
}

/** dsh 0.2 的 Host Connection 服务的结构化子集。 */
export interface HostConnectionLike {
  createSharedFetchHandler(channel: '/api'): {
    fetch(request: Request): Promise<Response>
  }
}
