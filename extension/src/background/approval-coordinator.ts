import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from '../security/approval.ts'

export type ApprovalRequestResult =
  | { status: 'decision'; decision: ApprovalDecision }
  | { status: 'unavailable' | 'timed-out' | 'cancelled' }

interface PendingApproval {
  request: ApprovalRequest
  resolve: (result: ApprovalRequestResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface ApprovalCoordinatorCallbacks {
  /** 把请求交给每个开着的控制条；有谁接下就返回 true。 */
  deliver: (request: ApprovalRequest) => boolean
  /** 一个控制条都没开时，退回系统通知。 */
  notify: (request: ApprovalRequest) => void
  clearNotification: (id: string) => void
  resolved: (id: string) => void
}

/**
 * 留给用户做决定的时间。
 *
 * 控制条是个弹出面板，审批到达时它通常正关着：用户得先看到通知或工具栏徽标，
 * 打开控制条，再把摘要读一遍。两分钟是容得下这一串动作的最小窗口，
 * 又不至于让一个过期的请求无限期地挂着。
 */
export const APPROVAL_TIMEOUT_MS = 120_000

/**
 * 管着待审批请求，不跟着任何视图的生命周期走。
 *
 * 控制条是短命弹窗，所以一个请求该不该被看到，不取决于此刻谁在看：
 * 它交给当时存在的视图，留在 `pending` 里，之后再打开视图时重放一遍。
 */
export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly callbacks: ApprovalCoordinatorCallbacks,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS,
  ) {}

  request(prompt: ApprovalPrompt, signal: AbortSignal, sessionId?: string): Promise<ApprovalRequestResult> {
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' })
    const request: ApprovalRequest = {
      ...prompt,
      id: crypto.randomUUID(),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    return new Promise((resolve) => {
      const onAbort = (): void => { this.settle(request.id, { status: 'cancelled' }) }
      const resolveWithCleanup = (result: ApprovalRequestResult): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const timer = setTimeout(() => { this.settle(request.id, { status: 'timed-out' }) }, this.timeoutMs)
      this.pending.set(request.id, { request, resolve: resolveWithCleanup, timer })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        this.settle(request.id, { status: 'cancelled' })
        return
      }
      if (!this.callbacks.deliver(request)) this.callbacks.notify(request)
    })
  }

  respond(id: string, decision: ApprovalDecision): void {
    this.settle(id, { status: 'decision', decision })
  }

  /** 每个还在等决定的请求，最旧的在前。 */
  pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ request }) => ({ ...request, origins: [...request.origins] }))
  }

  /** 丢掉某个调用方挂起的请求，但不说用户已经决定过它。 */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { status: 'cancelled' })
    }
  }

  /** 那些已经没有可见控制条的请求，给它们发通知。 */
  notifyPending(): void {
    for (const { request } of this.pending.values()) {
      this.callbacks.notify(request)
    }
  }

  private settle(id: string, result: ApprovalRequestResult): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
    this.callbacks.clearNotification(id)
    this.callbacks.resolved(id)
  }
}
