/**
 * 面板为一次工具调用显示的活动行。
 *
 * 纯格式化逻辑，放在 worker 入口之外，所以不用搭一套 `chrome` API 就能断言它：
 * 它把一次调用和它的回答，变成活动列表渲染出来的那一行。
 *
 * @module
 */

import type { ToolAnswer, ToolCall } from './tools.ts'
/**
 * 每次调用都留一行读得懂的记录，哪怕这个工具从来不需要审批。
 *
 * 这一行记的是**结果**，不只是"试过"。"browser_navigate
 * https://www.bilibili.com" 只说了请求什么，没说它到底发生没有，
 * 读者就分不清哪一步完成了、哪一步还挂着——整张列表看着像同一条请求重复了好多遍。
 * 各个工具本来就会用一行 `text` 说清自己干了什么，所以展示的就是那一行。
 *
 * 刻意不回显用户键入的文本（`browser_type` 的值可能是密码或 token），
 * 并把 URL 收敛到它的 origin（路径里带着会话 id、邀请码和搜索词）。
 * 控制条虽然是本地的，但页面输入不该在任何长期留存的列表里堆着。也正因如此，
 * 多行结果——比如一次快照——会被压成一句摘要，而不是原样引用。
 */
export function activitySummary(call: ToolCall, answer: ToolAnswer): string {
  const target = activityTarget(call)
  const head = target === '' ? call.name : `${call.name} ${target}`
  if (!answer.ok) {
    const message = answer.error?.message ?? 'failed'
    return `${head} · ${redactTypedText(message, call)}`
  }
  if (call.name === 'browser_type') {
    const length = typeof call.args.text === 'string' ? call.args.text.length : 0
    return `${head} (${length} chars)`
  }
  const outcome = activityOutcome(answer.result, call.name)
  return outcome === undefined ? head : `${head} ✓ ${outcome}`
}

/**
 * 把错误消息里键入的值抠掉，原因的其他部分留着。
 *
 * 被拒的 `browser_type` 会引用用户敲进去的内容——"has no option matching
 * \"<value>\""——密码或 token 就是这么进到活动列表和时间线里的，而这两处都是
 * 本模块承诺绝不回显键入文本的地方。原因本身还是值得展示，对模型来说也本来就是一回事，
 * 所以这里抠掉那个值，而不是把整条消息丢掉。
 *
 * 替换文本带着长度，这样这一行在没有内容时照样有用，也和 `browser_type`
 * 调用成功时的措辞一致。
 *
 * @param message - 工具报告的失败文本。
 * @param call - 这次调用，用来取回被键入的那段确切文本。
 * @returns 键入值已经被替换掉的消息。
 */
function redactTypedText(message: string, call: ToolCall): string {
  const typed = call.args.text
  if (typeof typed !== 'string' || typed === '') return message
  // 只有键入文本的那个工具才可能引用它；工具名和 URL 在这一行里本来就是公开的，
  // 对它们做脱敏，抹掉的是原因，不是秘密。
  if (call.name !== 'browser_type') return message
  if (!message.includes(typed)) return message
  return message.split(typed).join(`(${String(typed.length)} chars)`)
}

/**
 * 用一句简短的单行文字，说清一次成功调用实际干了什么。
 *
 * 每个工具都用 `{ text }` 作答（content script 的 action 和 tab 类工具都一样），
 * 所以那段文本的**第一行**就是结果。第一行要是长到不可能是结果，那它就是恰好挂在
 * 结果开头的页面内容；与其截断塞进列表，不如丢掉。
 */
export function activityOutcome(result: unknown, tool = ''): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const { text, tabs, snapshot } = result as { text?: unknown; tabs?: unknown; snapshot?: unknown }
  if (Array.isArray(tabs)) return `${String(tabs.length)} tabs listed`
  if (typeof text !== 'string') return snapshot === undefined ? undefined : 'snapshot captured'

  // 读取类结果会被包在不可信内容边界里，头几行是安全提示和带 nonce 的标签——
  // 两者都不是结果。`browser_list_tabs` 把它的 tab 记录放在同一个包装里，
  // 所以计数从 payload 里读——但只对列出 tab 的那个工具这么做。其他被包装的结果
  // 都是页面内容，而页面完全可以塞一段带 `tabs` 数组的 JSON；把那种东西报成
  // "N tabs listed"，就是把一次读取说成了一次列表。
  const inner = payloadBetweenMarkers(text)
  if (inner !== undefined) {
    if (tool !== 'browser_list_tabs') return undefined
    const listed = countTabs(inner)
    // 这个格式器读不懂的包装 payload 就是页面内容，把开头的花括号引出来比什么都不显示更糟。
    return listed === undefined ? undefined : `${String(listed)} tabs listed`
  }

  const firstLine = text.trim().split('\n', 1)[0]?.trim() ?? ''
  // 信任提示的片段也不是结果：被包装的 payload 被截到什么都不剩时，它就会冒出来。
  if (firstLine === '' || firstLine.length > 90 || firstLine.startsWith('Security:')) return undefined
  return firstLine
}

/** 不可信内容标记之间的正文；没有包装时返回 undefined。 */
function payloadBetweenMarkers(text: string): string | undefined {
  const open = /<UNTRUSTED_PAGE_CONTENT[^>]*>\n?/u.exec(text)
  if (open === null) return undefined
  const rest = text.slice(open.index + open[0].length)
  const close = rest.indexOf('\n</UNTRUSTED_PAGE_CONTENT')
  return (close === -1 ? rest : rest.slice(0, close)).trim()
}

/** `browser_list_tabs` 的 payload 是那种形状时，它列出了多少条 tab 记录。 */
function countTabs(payload: string): number | undefined {
  if (!payload.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const listed = (parsed as { tabs?: unknown }).tabs
    return Array.isArray(listed) ? listed.length : undefined
  } catch {
    return undefined
  }
}

/** 一次调用的参数里安全、不掺秘密的那部分，给活动列表用。 */
function activityTarget(call: ToolCall): string {
  const url = typeof call.args.url === 'string' ? call.args.url : ''
  if (url !== '') {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  }
  const index = typeof call.args.index === 'number' ? call.args.index : undefined
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0 ? ` frame=${call.args.frame}` : ''
  if (index !== undefined) return `[${index}]${frame}`
  const key = typeof call.args.key === 'string' ? call.args.key : ''
  if (key !== '') return `${key}${frame}`
  const direction = typeof call.args.direction === 'string' ? call.args.direction : ''
  return direction === '' ? '' : `${direction}${frame}`
}

