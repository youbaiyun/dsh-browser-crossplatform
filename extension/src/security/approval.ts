/** 控制条和 background 之间共享的浏览器操作审批契约。 */

export type ApprovalKind = 'read' | 'action'
export type ApprovalDecision = 'deny' | 'allow-once' | 'always-allow-reads' | 'trust-session' | 'trust-origin'
/** background 的授权结果；传输失败绝不能伪装成用户决定。 */
export type ApprovalAuthorization = 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'

/** 一个等用户回话的策略决定。 */
export interface ApprovalPrompt {
  kind: ApprovalKind
  action: string
  summary: string
  origins: string[]
  /** 只有某一个稳定 origin 能安全地加进操作允许列表时才为 true。 */
  canTrust: boolean
}

/**
 * 投给每个已打开控制条的关联请求。
 *
 * `sessionId` 是 bridge 回传的，这样多个 dsh 对话驱动同一个浏览器时，记录仍然自带
 * 出处；但控制条从来不用解析或恢复那个对话：它归桌面端 GUI 所有。
 */
export interface ApprovalRequest extends ApprovalPrompt {
  id: string
  /** 请求这次浏览器操作的 agent 会话（知道的话）。 */
  sessionId?: string
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'deny'
    || value === 'allow-once'
    || value === 'always-allow-reads'
    || value === 'trust-session'
    || value === 'trust-origin'
}
