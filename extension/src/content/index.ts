/**
 * content script 入口：听 background service worker 发来的 DSH_ACTION 消息，
 * 在真实页面上执行动作，只拿文本作答。
 * 它还会启动那个把快照标脏的 DOM 监视器。
 *
 * 只有 content script 碰得到页面；除了结构化的文本快照，
 * bridge 和模型永远看不到页面内部。
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@dsh-browser/protocol'
import { runAction, ActionError } from './actions.ts'
import { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'

/** 协商好的快照预算，由 background 用消息打补丁进来。 */
let budget: SnapshotBudget = { maxItems: 60, maxForms: 30, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }

const ids = new ElementIds()

const CONTENT_SCRIPT_LISTENER = '__dshBrowserContentScriptListener__'
type ContentListener = typeof onMessage

/** 给 bridge 的工具调用结果。 */
export interface ToolResult {
  ok: boolean
  result?: { text: string; pageContent?: string; navigationPending?: boolean }
  error?: { code: string; message: string }
}

function onMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: ToolResult) => void): true | undefined {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  if (msg.type === 'DSH_BUDGET') {
    const incoming = (message as { budget?: Partial<SnapshotBudget> }).budget
    if (incoming !== undefined) {
      budget = { ...budget, ...incoming }
      sendResponse({ ok: true, result: { text: `快照预算已更新: ${JSON.stringify(budget)}` } })
    }
    return
  }
  if (msg.type !== 'DSH_ACTION') return
  const actionMsg = message as {
    action?: string
    args?: Record<string, unknown>
    budget?: Partial<SnapshotBudget>
    includePageDelta?: boolean
  }
  const action = actionMsg.action ?? ''
  const args = actionMsg.args ?? {}
  const actionBudget = actionMsg.budget === undefined ? budget : { ...budget, ...actionMsg.budget }
  void runAction(action, args, {
    ids,
    budget: actionBudget,
    includePageDelta: actionMsg.includePageDelta === true,
  }).then(
    (result) => { sendResponse({ ok: true, result }) },
    (error: unknown) => {
      const code = error instanceof ActionError ? error.code : 'action-failed'
      const messageText = error instanceof Error ? error.message : String(error)
      sendResponse({ ok: false, error: { code, message: messageText } })
    },
  )
  return true // 异步响应
}

// 靠 executeScript 把扩展安装/重载之前就打开的标签页也救回来。
// 把隔离世界里残留的旧监听器替换掉，这样每次重载装上的都是
// 属于当前扩展上下文的那个监听器。
const contentGlobal = globalThis as typeof globalThis & {
  [CONTENT_SCRIPT_LISTENER]?: ContentListener
}
const previousListener = contentGlobal[CONTENT_SCRIPT_LISTENER]
if (previousListener !== undefined) {
  try { chrome.runtime.onMessage.removeListener(previousListener) } catch { /* 扩展上下文已经过期 */ }
}
contentGlobal[CONTENT_SCRIPT_LISTENER] = onMessage
chrome.runtime.onMessage.addListener(onMessage)

// 导航类动作在卸载之前就作答了。接替它的 content script
// 会宣告新文档什么时候可以接受自动快照。
void chrome.runtime.sendMessage({ type: 'DSH_CONTENT_READY' }).catch(() => {})
