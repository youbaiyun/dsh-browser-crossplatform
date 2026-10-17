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
  const rect = el.getBoundingClientRect()
  return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth
}

/** 把空白压平，再去掉首尾空白。 */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 元素的文本：能用就用 innerText（浏览器），否则用 textContent
 * （jsdom／边角情况）。
 *
 * 之所以导出，是因为带标注的渲染必须和普通渲染用一模一样的方式读文本；
 * 两次读得不一样，带标注的文本就成了另一个页面。
 *
 * @param el - 元素。
 * @returns 元素的文本。
 */
export function elementText(el: Element): string {
  if (el instanceof HTMLElement && typeof el.innerText === 'string') return el.innerText
  return el.textContent ?? ''
}

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
