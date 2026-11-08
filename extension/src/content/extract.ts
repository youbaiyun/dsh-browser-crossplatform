/**
 * 纯文本页面快照用的文本提取基础件：可见性、可访问名称、交互元素清单、
 * 正文启发式规则，以及截断小工具。
 *
 * 模型看到的整个页面就是这份快照（没有截图），所以每个辅助函数都冲着同一件事去：
 * 在严格的字符预算里产出密集、模型用得上的文本。
 *
 * @module
 */

/** 模型可能被要求操作的所有元素类型。 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  'summary',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(', ')

/** 单个条目的名称/状态文本的默认渲染上限。 */
const MAX_ITEM_NAME_CHARS = 80

/**
 * 元素对用户可不可见：没被 display/visibility/opacity 藏起来，而且占着布局空间。
 *
 * 可见与否看的是计算样式和盒子，绝不看元素的构造函数。内联 `<svg>` 不是
 * `HTMLElement`，拿这个类型当门槛，页面里每个 SVG 都会被报成隐藏——本身是图片的那些，
 * 以及包着真实点击目标的 SVG 图标都算。`getComputedStyle` 和 `getBoundingClientRect`
 * 对任何 `Element` 都有定义，所以这个问题它们答得上来。
 *
 * @param el - 候选元素。
 * @returns 元素会渲染时为 true。
 */
export function isVisible(el: Element): boolean {
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * 元素在不在当前视口里（用来给清单排序：用户看得见的排前面）。
 * @param el - 元素。
 * @returns 只要有任意一部分在视口里就为 true。
 */
export function isInViewport(el: Element): boolean {
  // 最小化的窗口里浏览器报告 0×0 视口，按下面这个公式整页都会落到视口外——
  // 那是在给模型一个“什么都看不见”的错误结论。视口尺寸不可信时干脆不标注。
  if (window.innerWidth <= 0 || window.innerHeight <= 0) return true
  const rect = el.getBoundingClientRect()
  return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth
}

/** 把空白压平，再去掉首尾空白。 */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 元素的文本：能用就用 innerText（浏览器），否则逐文本节点读。
 *
 * 后者刻意不用裸 `textContent`：`<svg>` 不是 `HTMLElement`，没有 `innerText`，
 * 而内联 SVG（以及任何非 HTMLElement 容器）里可能嵌着 `<style>`，裸读会把
 * CSS 源码当作页面正文交给模型（BUG 报告 P2-10）。
 *
 * 之所以导出，是因为带标注的渲染必须和普通渲染用一模一样的方式读文本；
 * 两次读得不一样，带标注的文本就成了另一个页面。
 *
 * @param el - 元素。
 * @returns 元素的文本。
 */
export function elementText(el: Element): string {
  // 残留着脚本/样式源码的子树走手工遍历：浏览器 innerText 会跳过它们，
  // 但非浏览器实现（测试环境）不一定，两边的快照必须一致。
  if (el instanceof HTMLElement && typeof el.innerText === 'string' && el.querySelector(TEXT_EXCLUDED_SELECTOR) === null) {
    return el.innerText
  }
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push((node as Text).data)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    if (TEXT_EXCLUDED.has(element.tagName.toUpperCase())) return
    for (const child of element.childNodes) walk(child)
  }
  walk(el)
  return parts.join(' ')
}

/** 不构成页面正文的元素：脚本、样式、模板与降级内容。 */
const TEXT_EXCLUDED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

const TEXT_EXCLUDED_SELECTOR = 'script, style, noscript, template'

/**
 * 按字符预算截断文本，并在截断处做标记。
 * @param text - 源文本。
 * @param max - 最多多少字符。
 * @returns `{ text, truncated }`，`truncated` 记的是被砍掉的字符数。
 */
export function truncate(text: string, max: number): { text: string; truncated: number } {
  if (text.length <= max) return { text, truncated: 0 }
  return { text: `${text.slice(0, max)}…`, truncated: text.length - max }
}

/**
 * 元素的可访问名称，按 ARIA 的优先级链来
 * （aria-label → aria-labelledby → 关联 label → 自身文本 →
 * placeholder/alt）。
 * @param el - 元素。
 * @returns 不超过 80 个字符的名称，实在没有才退回标签名。
 */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') return truncate(clean(ariaLabel), MAX_ITEM_NAME_CHARS).text

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const ref = document.getElementById(labelledBy.split(/\s+/)[0] ?? '')
    const refText = ref?.textContent
    if (refText !== undefined && refText.trim() !== '') return truncate(clean(refText), MAX_ITEM_NAME_CHARS).text
  }

  const labelable = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
  if (labelable) {
    if (el.id !== '') {
      const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(el.id)}"]`)
      const labelText = label?.textContent
      if (labelText !== undefined && labelText.trim() !== '') return truncate(clean(labelText), MAX_ITEM_NAME_CHARS).text
    }
    const wrappingLabelText = el.closest('label')?.textContent
    if (wrappingLabelText !== undefined && wrappingLabelText.trim() !== '') {
      return truncate(clean(wrappingLabelText), MAX_ITEM_NAME_CHARS).text
    }
  }

  const ownText = el instanceof HTMLInputElement ? '' : el.textContent
  if (ownText !== undefined && ownText.trim() !== '') return truncate(clean(ownText), MAX_ITEM_NAME_CHARS).text

  if (el instanceof HTMLInputElement) {
    // 按钮式的 input 把标签放在 `value` 里；其他 input 绝不拿当前值当名称
    // （那是数据，不是身份——密码/信用卡字段尤其如此，那会把机密泄进快照里）。
    const buttonLike = el.type === 'submit' || el.type === 'button' || el.type === 'reset'
    if (buttonLike && el.value !== '') return truncate(clean(el.value), MAX_ITEM_NAME_CHARS).text
    if (el.placeholder !== '') return truncate(clean(el.placeholder), MAX_ITEM_NAME_CHARS).text
    if (el.alt !== '') return truncate(clean(el.alt), MAX_ITEM_NAME_CHARS).text
    return truncate(clean(el.type), MAX_ITEM_NAME_CHARS).text
  }

  return el.tagName.toLowerCase()
}

/** 带降级实现的 CSS.escape，给没有它的环境用（jsdom）。 */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/**
 * 按文档顺序收齐页面里的交互元素，顺带去重、过滤可见性。
 * @param root - 要扫的 document 或元素。
 * @returns 交互元素清单。
 */
export function collectInteractive(root: Document | Element): Element[] {
  const seen = new Set<Element>()
  const result: Element[] = []
  for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (seen.has(el)) continue
    seen.add(el)
    if (isVisible(el)) result.push(el)
  }
  return result
}

/**
 * {@link mainText} 读的那个元素：main 地标、单篇 article、最大的多段落块，
 * 或者 body。
 *
 * 单独暴露出来，是因为带标注的渲染必须遍历和普通渲染同一个根。
 * 根选两次，两边对"页面内容是什么"就会各说各话。
 *
 * @param doc - 文档。
 * @returns 装着正文的元素。
 */
export function mainRoot(doc: Document): Element {
  const main = doc.querySelector('main, [role="main"]')
  if (main !== null) return main
  const articles = doc.querySelectorAll('article')
  if (articles.length === 1) return articles[0]!

  let best: Element | null = null
  let bestScore = 0
  for (const candidate of doc.querySelectorAll('section, div, [role="main"]')) {
    const paragraphs = candidate.querySelectorAll('p').length
    if (paragraphs < 2) continue
    const text = elementText(candidate)
    const score = text.length * Math.min(paragraphs, 5)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best ?? doc.body
}

/**
 * 正文之外、但属于「页面内容」的文字：标题、导语、正文区块外面的段落。
 *
 * 只挑正文根之外的分支，并且跳过页面框架（导航、侧栏、页脚、脚本样式）——
 * 这些正是 {@link mainRoot} 选正文时要躲开的东西。选中 main 地标以后不再看它外面的文字，
 * 会把 `<h1>` 和导语整段丢掉：快照就成了半张页面，模型也只能读半张（BUG 报告 P1-6）。
 *
 * 正文根不在 body 里时返回空串：没有可比对的「外面」。
 *
 * @param doc - 文档。
 * @param root - 装正文的元素。
 * @returns 清洗过的正文外围文字（可能为空）。
 */
export function surroundingText(doc: Document, root: Element): string {
  if (root === doc.body || !doc.body.contains(root)) return ''
  const parts: string[] = []
  const visit = (element: Element): void => {
    if (!doc.body.contains(element)) return
    // 正文本身（以及它内部的任何东西）已经由标注渲染负责，这里不能重复读。
    if (element === root || root.contains(element)) return
    if (element.contains(root)) {
      // 正文的祖先：只走进不包含正文的那些兄弟分支，避免把正文重复读一遍。
      for (const child of element.children) visit(child)
      return
    }
    if (PAGE_CHROME.has(element.tagName)) return
    // 逐文本节点收集，而不是整棵子树取文本：`<header><nav>…</nav></header>` 这类
    // 容器里既有真实内容又有页面框架，整取会把导航又带回来。
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = clean(node.textContent ?? '')
        if (text !== '') parts.push(text)
        continue
      }
      if (node.nodeType === Node.ELEMENT_NODE) visit(node as Element)
    }
  }
  visit(doc.body)
  return parts.join(' ')
}

/** 页面框架元素：不属于正文，也不属于正文外围。 */
const PAGE_CHROME = new Set(['NAV', 'ASIDE', 'FOOTER', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

/**
 * 尽力而为的正文提取（readability-lite）：先取 main 地标，再取单篇独立 article，
 * 都没有就取至少含两个段落的最大块。多篇 article 通常意味着卡片或信息流条目，
 * 只挑第一篇会把页面内容藏起来。
 * @param doc - 文档。
 * @returns 清洗过的正文文本（不设上限，预算由调用方来加）。
 */
export function mainText(doc: Document): string {
  return clean(elementText(mainRoot(doc)))
}

/**
 * 一个元素（或整篇文档）的完整文本。
 * @param root - 要读的元素；默认是 document body。
 * @returns 规范化后的文本。
 */
export function pageText(root?: Element | null): string {
  const source = root ?? document.body
  if (source === null || source === undefined) return ''
  return clean(elementText(source))
}
