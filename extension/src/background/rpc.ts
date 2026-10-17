/**
 * Gateway RPC 客户端：按 correlation id 把 `rpc`/`rpc.result` 帧对成 promise，
 * 带 30s 超时。每个 bridge 世代一个实例。
 *
 * bridge 用它的 ServerResponse 信封
 * （`{ type, rpcId, result: { ok, value | error } }`）回应 `rpc` 帧，所以这层门面
 * 把业务 `value` 交给调用方，业务失败则变成一个带着 gateway 自己消息的 Error。
 * socket 送来的其他东西，原样转给门面包装之前装好的那个 sink。
 *
 * @module
 */

import type { ServerFrame } from '@dsh-browser/protocol'
import type { BridgeClient } from './bridge.ts'

const RPC_TIMEOUT_MS = 30_000

interface PendingRpc {
  resolve(result: unknown): void
  reject(error: Error): void
  /** 只在超时或回包畸形时，给这次调用报个名字。 */
  method: string
  timer: ReturnType<typeof setTimeout>
}

/** 一条 gateway 业务回包：`{ ok: true, value }` 或 `{ ok: false, error }`。 */
interface ServerResponse {
  ok: boolean
  value?: unknown
  error?: { code?: unknown; message?: unknown }
}

/** 在一条活着的 bridge socket 上做 unary gateway 调用。 */
export interface RpcFacade {
  /** 发一次 unary gateway RPC，用它返回的业务值 resolve。 */
  request(method: string, payload: unknown): Promise<unknown>
  /** 让每个还在等答复的调用 reject，比如 socket 断开之后。 */
  fail(reason: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从一次成功的 `rpc.result` 里读出 gateway 的业务信封。
 *
 * bridge 内部方法改用裸对象（`{ accepted: true }`）作答，
 * 所以认不出来的回包原样返回，不会被解成 `undefined`。
 */
function serverResponse(result: unknown): ServerResponse | undefined {
  if (!isRecord(result)) return undefined
  const business = result.result
  if (!isRecord(business) || typeof business.ok !== 'boolean') return undefined
  return {
    ok: business.ok,
    ...('value' in business ? { value: business.value } : {}),
    ...(isRecord(business.error) ? { error: business.error } : {}),
  }
}

/** 业务失败就照 gateway 自己写下的来说，绝不用包装对象的说法去顶替。 */
function businessFailure(business: ServerResponse, method: string): Error {
  const message = typeof business.error?.message === 'string' ? business.error.message.trim() : ''
  if (message !== '') return new Error(message)
  const code = typeof business.error?.code === 'string' ? business.error.code : 'rpc-failed'
  return new Error(`The dsh gateway rejected ${method} (${code}).`)
}

/**
 * 在一条活着的 bridge 上建一个 RPC 门面。
 *
 * 把 bridge 的帧 sink 包一层，其他 handler 照旧能干活；`rpc.result` 帧按 correlation id
 * 结算。
 * @param bridge - 这个门面所属的 bridge 客户端。
 * @returns 这个门面：`request` 用于 unary 调用，`fail` 用于 socket 已死。
 */
export function createRpc(bridge: BridgeClient): RpcFacade {
  const pending = new Map<string, PendingRpc>()

  const previous = bridge.sinks.onFrame
  bridge.sinks.onFrame = (frame: ServerFrame): void => {
    previous?.(frame)
    if (frame.t !== 'rpc.result') return
    const entry = pending.get(frame.id)
    if (entry === undefined) return
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (!frame.ok) {
      // 传输层拒了：这里 code 是唯一稳定的身份标识。
      entry.reject(new Error(`${frame.error.code}: ${frame.error.message}`))
      return
    }
    const business = serverResponse(frame.result)
    if (business === undefined) {
      entry.resolve(frame.result)
      return
    }
    if (!business.ok) {
      entry.reject(businessFailure(business, entry.method))
      return
    }
    entry.resolve(business.value)
  }

  return {
    request(method: string, payload: unknown): Promise<unknown> {
      if (!bridge.connected) {
        // 调用方通常先检查、再抛本地化消息；这道守卫只是别让在检查和发送之间
        // 死掉的 socket 把调用一直挂着。
        return Promise.reject(new Error('The dsh bridge is not connected.'))
      }
      const id = crypto.randomUUID()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The dsh gateway did not answer ${method} within ${RPC_TIMEOUT_MS / 1_000}s.`))
        }, RPC_TIMEOUT_MS)
        pending.set(id, { resolve, reject, method, timer })
        if (bridge.send({ t: 'rpc', id, method, payload })) return
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`The dsh bridge socket closed before ${method} was sent.`))
      })
    },
    fail(reason: string): void {
      for (const [id, entry] of pending) {
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
      }
    },
  }
}
