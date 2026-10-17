// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalCoordinator,
} from '../src/background/approval-coordinator.ts'
import type { ApprovalRequest } from '../src/security/approval.ts'

const PROMPT = {
  kind: 'action' as const,
  action: 'browser_click',
  summary: 'Click element [3]',
  origins: ['https://example.com'],
  canTrust: true,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function harness(delivered = false, timeoutMs = APPROVAL_TIMEOUT_MS) {
  const callbacks = {
    deliver: vi.fn((_request: ApprovalRequest) => delivered),
    notify: vi.fn((_request: ApprovalRequest) => undefined),
    clearNotification: vi.fn((_id: string) => undefined),
    resolved: vi.fn((_id: string) => undefined),
  }
  const coordinator = new ApprovalCoordinator(callbacks, timeoutMs)
  return { callbacks, coordinator }
}

describe('ApprovalCoordinator', () => {
  it('hands a deliverable request to the control strip and leaves it pending', async () => {
    const { callbacks, coordinator } = harness(true)

    const pending = coordinator.request(PROMPT, new AbortController().signal)

    expect(callbacks.deliver).toHaveBeenCalledTimes(1)
    expect(callbacks.deliver).toHaveBeenCalledWith(expect.objectContaining({
      action: 'browser_click',
      summary: 'Click element [3]',
      canTrust: true,
    }))
    // 有视图接了它，所以操作系统通知这条兜底路径必须保持安静。
    expect(callbacks.notify).not.toHaveBeenCalled()
    expect(callbacks.resolved).not.toHaveBeenCalled()
    expect(coordinator.pendingRequests()).toHaveLength(1)

    const request = coordinator.pendingRequests()[0]
    // 控制条的请求和会话无关：会话身份由 dsh 一侧持有，
    // 浏览器只关联一次工具调用。
    expect('sessionId' in request).toBe(false)

    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    coordinator.respond(request.id, 'allow-once')
    await expect(pending).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
    expect(callbacks.clearNotification).toHaveBeenCalledWith(request.id)
    expect(callbacks.resolved).toHaveBeenCalledWith(request.id)
    expect(coordinator.pendingRequests()).toEqual([])
  })

  it('falls back to a notification when no control strip accepted the request', async () => {
    const { callbacks, coordinator } = harness(false)

    const pending = coordinator.request(PROMPT, new AbortController().signal)
    const request = coordinator.pendingRequests()[0]

    expect(callbacks.deliver).toHaveBeenCalledTimes(1)
    expect(callbacks.notify).toHaveBeenCalledTimes(1)
    // notify 只收一个参数：没有可寻址的视图 id，而且它
    // 报的就是控制条拿到的那同一个已关联请求。
    expect(callbacks.notify.mock.calls[0]).toHaveLength(1)
    expect(callbacks.notify.mock.calls[0]![0].id).toBe(callbacks.deliver.mock.calls[0]![0].id)
    expect(callbacks.notify.mock.calls[0]![0].summary).toBe(PROMPT.summary)

    coordinator.respond(request.id, 'deny')
    await expect(pending).resolves.toEqual({ status: 'decision', decision: 'deny' })
  })

  it('notifies again for requests that lost their last visible control strip', () => {
    const { callbacks, coordinator } = harness(true)
    coordinator.request(PROMPT, new AbortController().signal)
    coordinator.request({ ...PROMPT, action: 'browser_navigate' }, new AbortController().signal)
    expect(callbacks.notify).not.toHaveBeenCalled()

    coordinator.notifyPending()

    expect(callbacks.notify).toHaveBeenCalledTimes(2)
    for (const call of callbacks.notify.mock.calls) expect(call).toHaveLength(1)
    coordinator.cancelAll()
  })

  it('times out only after the full approval window', async () => {
    vi.useFakeTimers()
    // 用户得注意到通知并打开控制条，所以这个
    // 时间窗按分钟算，不按秒。
    expect(APPROVAL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    const { callbacks, coordinator } = harness(true)

    const pending = coordinator.request(PROMPT, new AbortController().signal)
    const request = coordinator.pendingRequests()[0]
    let settled = false
    void pending.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    expect(coordinator.pendingRequests()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ status: 'timed-out' })
    expect(settled).toBe(true)
    expect(callbacks.clearNotification).toHaveBeenCalledWith(request.id)
    expect(callbacks.resolved).toHaveBeenCalledTimes(1)
    expect(coordinator.pendingRequests()).toEqual([])

    // 迟到的答复救不活时间窗已经关掉的请求。
    coordinator.respond(request.id, 'allow-once')
    expect(callbacks.resolved).toHaveBeenCalledTimes(1)
  })

  it('settles cancelled when its tool call is withdrawn', async () => {
    const { callbacks, coordinator } = harness(true)
    const abort = new AbortController()

    const pending = coordinator.request(PROMPT, abort.signal)
    const request = coordinator.pendingRequests()[0]
    abort.abort()

    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(callbacks.clearNotification).toHaveBeenCalledWith(request.id)
    expect(callbacks.resolved).toHaveBeenCalledTimes(1)
    expect(coordinator.pendingRequests()).toEqual([])
  })

  it('settles an already-aborted call without asking any view', async () => {
    const { callbacks, coordinator } = harness(true)
    const abort = new AbortController()
    abort.abort()

    await expect(coordinator.request(PROMPT, abort.signal)).resolves.toEqual({ status: 'cancelled' })

    expect(callbacks.deliver).not.toHaveBeenCalled()
    expect(callbacks.notify).not.toHaveBeenCalled()
    expect(callbacks.resolved).not.toHaveBeenCalled()
    expect(coordinator.pendingRequests()).toEqual([])
  })

  it('cancelAll settles every pending request as cancelled', async () => {
    const { callbacks, coordinator } = harness(true)
    const abort = new AbortController()
    const first = coordinator.request(PROMPT, new AbortController().signal)
    const second = coordinator.request(PROMPT, abort.signal)
    const [firstRequest, secondRequest] = coordinator.pendingRequests()
    expect(coordinator.pendingRequests()).toHaveLength(2)

    coordinator.cancelAll()

    await expect(first).resolves.toEqual({ status: 'cancelled' })
    await expect(second).resolves.toEqual({ status: 'cancelled' })
    expect(callbacks.resolved).toHaveBeenCalledTimes(2)
    expect(callbacks.resolved).toHaveBeenCalledWith(firstRequest!.id)
    expect(callbacks.resolved).toHaveBeenCalledWith(secondRequest!.id)
    expect(callbacks.clearNotification).toHaveBeenCalledTimes(2)
    expect(coordinator.pendingRequests()).toEqual([])

    // 已经没什么可结算的了，迟到的 abort 也不能结算两次。
    coordinator.cancelAll()
    abort.abort()
    coordinator.respond(firstRequest!.id, 'allow-once')
    expect(callbacks.resolved).toHaveBeenCalledTimes(2)
  })

  it('returns live pending requests without leaking the internal map', async () => {
    const { coordinator } = harness(true)
    const first = coordinator.request(PROMPT, new AbortController().signal)
    const second = coordinator.request(
      { ...PROMPT, action: 'browser_navigate' },
      new AbortController().signal,
    )

    const live = coordinator.pendingRequests()
    expect(live).toHaveLength(2)
    expect(live.map((request) => request.action)).toEqual(['browser_click', 'browser_navigate'])
    expect(new Set(live.map((request) => request.id)).size).toBe(2)

    // 改调用方拿到的任何东西，都破坏不了协调器。
    live.pop()
    live[0]!.summary = 'tampered'
    live[0]!.origins.push('https://evil.example')
    const again = coordinator.pendingRequests()
    expect(again).toHaveLength(2)
    expect(again[0]).not.toBe(live[0])
    expect(again[0]!.summary).toBe(PROMPT.summary)
    expect(again[0]!.origins).toEqual(PROMPT.origins)
    expect(again[0]!.origins).not.toBe(live[0]!.origins)

    // 已结算的请求会从活动列表里离开。
    coordinator.respond(again[0]!.id, 'always-allow-reads')
    await expect(first).resolves.toEqual({ status: 'decision', decision: 'always-allow-reads' })
    expect(coordinator.pendingRequests()).toHaveLength(1)
    expect(coordinator.pendingRequests()[0]!.id).toBe(again[1]!.id)

    coordinator.respond(again[1]!.id, 'deny')
    await expect(second).resolves.toEqual({ status: 'decision', decision: 'deny' })
    expect(coordinator.pendingRequests()).toEqual([])
  })

  it('fires resolved exactly once per settle, whichever path settles it', async () => {
    const { callbacks, coordinator } = harness(true)
    const abort = new AbortController()
    const decided = coordinator.request(PROMPT, abort.signal)
    const withdrawn = coordinator.request(PROMPT, new AbortController().signal)
    const [first, second] = coordinator.pendingRequests()

    coordinator.respond(first!.id, 'trust-origin')
    // 重复的、未知 id、迟到的 abort，都会被忽略。
    coordinator.respond(first!.id, 'deny')
    coordinator.respond('12345678-1234-4234-8234-123456789abc', 'deny')
    abort.abort()
    expect(callbacks.resolved).toHaveBeenCalledTimes(1)
    expect(callbacks.resolved).toHaveBeenCalledWith(first!.id)
    expect(callbacks.clearNotification).toHaveBeenCalledTimes(1)
    await expect(decided).resolves.toEqual({ status: 'decision', decision: 'trust-origin' })

    coordinator.cancelAll()
    await expect(withdrawn).resolves.toEqual({ status: 'cancelled' })
    expect(callbacks.resolved).toHaveBeenCalledTimes(2)
    expect(callbacks.resolved).toHaveBeenLastCalledWith(second!.id)
    expect(callbacks.clearNotification).toHaveBeenCalledTimes(2)
  })
})
