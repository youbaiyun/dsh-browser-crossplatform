import { describe, expect, it } from 'vitest'
import { oneShotSessionSnapshot } from '../src/session-history.ts'
import type { TypertGatewayLike } from '../src/dsh-gateway.ts'

/**
 * 一个「只容许一条活跃 follow 流」的宿主机假件：新流一开，旧流立刻以
 * `gateway/cancelled`（"Remote invocation "session/follow" was aborted"）收场。
 * 真实宿主机就是这个行为，桥接必须自己排队，否则并发的历史读取会有一半失败。
 */
function singleFollowHost(options: { delayMs?: number; abortFirstOpenOnce?: boolean } = {}) {
  const active = new Set<AbortController>()
  let opened = 0
  let abortedOnce = false
  const open = async (
    _endpoint: string,
    _payload: unknown,
    _uplink: AsyncIterable<unknown>,
    _peer: unknown,
    signal: AbortSignal,
  ) => {
    opened += 1
    const controller = new AbortController()
    if (options.abortFirstOpenOnce === true && !abortedOnce) {
      // 模拟桌面端自己正在跟进同一会话：第一次开流必然被别人的活跃流挤掉。
      abortedOnce = true
      const failure = Object.assign(new Error('Remote invocation "session/follow" was aborted'), {
        code: 'gateway/cancelled',
      })
      return {
        async *[Symbol.asyncIterator]() {
          throw failure
        },
      }
    }
    for (const previous of [...active]) {
      active.delete(previous)
      previous.abort(Object.assign(new Error('Remote invocation "session/follow" was aborted'), {
        code: 'gateway/cancelled',
      }))
    }
    active.add(controller)
    return {
      async *[Symbol.asyncIterator]() {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, options.delayMs ?? 3)
            const abort = () => {
              clearTimeout(timer)
              reject(Object.assign(new Error('aborted by caller'), { code: 'gateway/cancelled' }))
            }
            controller.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(controller.signal.reason as Error)
            }, { once: true })
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
          yield { type: 'snapshot', cursor: 1, records: [{ type: 'event', event: { type: 'session/meta' } }], hasMore: false }
        } finally {
          active.delete(controller)
        }
      },
    }
  }
  const gateway: TypertGatewayLike = {
    invoke: async () => { throw new Error('no unary calls expected') },
    wireStream: {
      open,
      failure: (error: unknown) => {
        const value = error as { code?: unknown; message?: unknown }
        return { code: String(value.code ?? 'internal'), message: String(value.message ?? error), details: {} }
      },
    },
  }
  return { gateway, opened: () => opened }
}

describe('oneShotSessionSnapshot', () => {
  it('serializes follow streams per Session, so concurrent history reads all succeed', async () => {
    const host = singleFollowHost()
    const outer = new AbortController().signal
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      oneShotSessionSnapshot(host.gateway, 'session-1', outer, undefined)))
    expect(results).toHaveLength(3)
    for (const result of results) expect(result).toMatchObject({ cursor: 1, hasMore: false })
    expect(host.opened()).toBe(3)
  })

  it('retries once when another consumer aborts the first stream', async () => {
    const host = singleFollowHost({ abortFirstOpenOnce: true })
    const snapshot = await oneShotSessionSnapshot(host.gateway, 'session-1', new AbortController().signal, undefined)
    expect(snapshot.cursor).toBe(1)
    expect(host.opened()).toBe(2)
  })

  it('does not retry when the caller aborted the read', async () => {
    const host = singleFollowHost()
    const controller = new AbortController()
    controller.abort(new Error('client gone'))
    await expect(oneShotSessionSnapshot(host.gateway, 'session-1', controller.signal, undefined))
      .rejects.toThrow(/aborted|abort/i)
  })
})
