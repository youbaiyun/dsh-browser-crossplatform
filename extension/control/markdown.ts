/**
 * 为模型的回复渲染 Markdown。
 *
 * 助手用 Markdown 作答——列表、表格、围栏代码——面板就得把它渲染出来，
 * 否则一条回复读起来就是一堆原始标点。这就意味着要插 HTML，而页面给来的
 * 字符串恰恰可能在这里变成脚本，所以每个字节都先过一遍窄 allowlist 的
 * DOMPurify。
 *
 * 这份配置与桌面客户端的允许范围一致：链接、行内格式和代码，不允许图片
 * （远程图片会泄露面板正开着这件事）、不允许内嵌框架、不允许事件处理属性。
 *
 * @module
 */

import DOMPurify from 'dompurify'
import { marked } from 'marked'

const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'th',
  'thead', 'tr', 'ul',
]

const ALLOWED_ATTR = ['align', 'class', 'href', 'start', 'title']

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  // 只允许 http(s) 链接：`javascript:` 或 `data:` 的 href 绝不能存活下来。
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['img', 'iframe', 'object', 'embed', 'form', 'input', 'style', 'script'],
}

marked.setOptions({ gfm: true, breaks: true })

/**
 * 补上一个没写完的围栏代码块。
 *
 * 一条回复在流式输出时，尾巴可能是半个 ``` 围栏，不补的话它会把后面整段
 * 记录都吞进同一个代码块里，直到闭合围栏到达为止。
 */
export function stabilizeStreamingMarkdown(text: string): string {
  const fences = (text.match(/^```/gm) ?? []).length
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

/**
 * 渲染好的回复，以源文本为键。
 *
 * 一个工具步骤到达、一个审批出现、一行展开——每一样都会重建记录，而重建会
 * 把屏幕上已有的每条回复都重新渲染一遍 Markdown。这让一次小小的更新也要
 * 付出解析整段对话的代价。这个映射是纯的（同样的源，同样的 HTML），一份
 * 缓存就能把重复的工作完全消掉。
 *
 * 有上限，免得跑一整天的会话把它撑到无限大，但上限必须盖住它服务的这段
 * 记录：worker 保留 `TIMELINE_LIMIT`（200）行，所以一段长对话能装下约 100 条
 * 助手回复。缓存比这还小，每次重建就有一半以上未命中，而那正是加它要
 * 消掉的大部分开销。
 *
 * 淘汰按最近最少使用，不是先进先出：一次命中会重新插入，所以正在屏幕上的
 * 那些回复保持温热，只有滚出时间线的那批才会变凉。
 */
const CACHE_LIMIT = 200
const rendered = new Map<string, string>()

/**
 * 把一个 Markdown 字符串渲染成净化后的 HTML，源没变时复用上一次的结果。
 *
 * @param text - Markdown 源文本，可能是流式输出中途被截断的。
 * @returns 可以安全赋给 `innerHTML` 的 HTML。
 */
export function renderMarkdown(text: string): string {
  const cached = rendered.get(text)
  if (cached !== undefined) {
    // `Map` 按插入顺序迭代，命中后重新插入正是它成为 LRU 的原因：一次
    // 重建反复要的那些条目会移到末尾并留下来，只有已经离开屏幕的文本才会老去。
    rendered.delete(text)
    rendered.set(text, cached)
    return cached
  }

  const source = stabilizeStreamingMarkdown(text)
  const html = marked.parse(source, { async: false }) as string
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string
  // `target` 和 `rel` 没法写进上面的 allowlist，所以它们在净化之后才加上，
  // 那时候已经没有任何受攻击者控制的标记了。
  const result = clean.replace(/<a href="/g, '<a rel="noreferrer noopener" target="_blank" href="')

  if (rendered.size >= CACHE_LIMIT) {
    const oldest = rendered.keys().next()
    if (!oldest.done) rendered.delete(oldest.value)
  }
  rendered.set(text, result)
  return result
}

/** 一个字符串里是否有值得按 Markdown 渲染的内容。 */
export function hasMarkdownContent(text: string): boolean {
  return text.trim() !== ''
}
