/**
 * 用户明确交接标签页之后注入的、给模型看的浏览器页面上下文。
 *
 * 用户选择跟随页面之后，扩展会立刻抓取该页面。活跃的 Agent 马上收到那份快照；延迟创建的
 * session 只留最新的一份，直到 `agent/created` 把它发布出来。活跃 inbox 同样只留最新的
 * 一份未被认领的浏览器快照。注入刻意不唤醒空闲的 Agent——快照会和用户的下一条消息一起被
 * 认领。
 *
 * @module
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** bridge-browser 自有的、被跟随标签页的页面快照。 */
    'browser-context': {
      kind: 'browser-context'
    } & ContextFormed
  }
}

/** 快照取代和 transcript 呈现用的 MessageSource.kind。 */
export const BROWSER_CONTEXT_KIND = 'browser-context' as const

/** 限制被孤立的临时 session，同时不影响正常的近期标签页。 */
const DEFAULT_MAX_PENDING = 32

/** 由抓取到的浏览器快照构造一条不可变的上下文消息。 */
export function createBrowserSnapshotMessage(snapshot: string): UserMessage {
  const text = [
    'The user chose to follow the newly active browser tab. The browser page context was refreshed immediately after that choice.',
    'The following is an already completed browser_snapshot of the current page. Use its stable indices directly for the next request; do not take an immediate duplicate snapshot unless required context is missing.',
    snapshot,
  ].join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: BROWSER_CONTEXT_KIND,
      form: 'snapshot',
      sections: [{ name: 'browser-page', text }],
    },
  })
}

/** 通过持久化的 Inbox 命令接口取代待处理的标签页上下文。 */
function injectLatestSnapshot(agent: Agent, snapshot: string): void {
  for (const message of agent.inbox.nextStep) {
    if (message.source.kind === BROWSER_CONTEXT_KIND
      && message.source.form === 'snapshot') {
      agent.inbox.remove(message.id)
    }
  }
  agent.inject(createBrowserSnapshotMessage(snapshot))
}

/** 把被跟随页面的快照投给活跃的、或还没建出来的 Agent。 */
export class BrowserContextInjector {
  private readonly pending = new Map<string, string>()

  constructor(
    private readonly agents: Pick<AgentRegistry, 'get'>,
    private readonly maxPending = DEFAULT_MAX_PENDING,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('browser context maxPending must be a positive integer')
    }
  }

  /** 能注入就马上注入；否则按 session 留住最新的一份快照。 */
  inject(sessionId: string, snapshot: string): 'injected' | 'queued' {
    const agent = this.agents.get(sessionId as Parameters<AgentRegistry['get']>[0])
    if (agent !== undefined) {
      this.pending.delete(sessionId)
      injectLatestSnapshot(agent, snapshot)
      return 'injected'
    }

    // 同一个临时 session 再次跟随页面时，把它的插入顺序刷新一下。
    this.pending.delete(sessionId)
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.pending.set(sessionId, snapshot)
    return 'queued'
  }

  /** 在受支持的 Agent 启动边界上，把一个临时 session 冲刷出去。 */
  activate(agent: Agent): boolean {
    const sessionId = String(agent.id)
    const snapshot = this.pending.get(sessionId)
    if (snapshot === undefined) return false
    injectLatestSnapshot(agent, snapshot)
    this.pending.delete(sessionId)
    return true
  }
}
