/**
 * bridge 自有的 Host API，由 WebSocket 承载层使用。
 *
 * 这道边界把与发行版本相关的 Host 拓扑挡在浏览器 wire server 之外。dsh 0.1.5 用 Typert
 * Remotes 和 Connection 把它实现出来。
 *
 * @module
 */

import type { RespondResult } from '@dsh-browser/protocol'

/** 扩展面板看得懂的稳定失败信封。 */
export interface HostRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** 当前 dsh Host 适配器返回的业务结果。 */
export type HostRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HostRpcFailure }

/** WebSocket 解码之后的一次由扩展发起的 unary 调用。 */
export interface HostRpcCall {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
  readonly signal: AbortSignal
}

/** 留给 bridge 到扩展这条私有协议的事件。 */
export interface HostEventFrame {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/** WebSocket 承载层要用到的 dsh Host API 面。 */
export interface BrowserHostApi {
  call(call: HostRpcCall): Promise<HostRpcResult>
  events(signal: AbortSignal): AsyncIterable<HostEventFrame>
  respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown>
  /** 释放适配器自己创建的资源（Peer）；旧实现可以没有。 */
  dispose?(): Promise<void>
}

/** 把任何 Host 拒绝都转换成开放的 wire 失败词汇。 */
export function hostFailure(error: unknown): HostRpcFailure {
  if (isRecord(error)) {
    const code = typeof error.code === 'string' ? error.code : 'internal'
    const message = typeof error.message === 'string' ? error.message : String(error)
    const details = isRecord(error.details) ? error.details : {}
    return { code, message, details }
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

/** 收窄未知的类 JSON 数据，数组不算。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
