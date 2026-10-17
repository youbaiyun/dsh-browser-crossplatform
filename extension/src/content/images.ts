/**
 * 图片清单：页面里有哪些图片、在哪儿，以及它们的文本替代是不是已经把内容说清楚了。
 *
 * 快照是纯文本，图片对模型本来就不存在——不是“难读”，而是根本没有：
 * `innerText`/`textContent` 从不包含 `alt`，交互选择器也不匹配 `img`。
 * 这个模块把每张图片变成一条带编号、可点击、带文本标注的条目。
 *
 * 有两个后果是刻意为之：
 *
 * - 返回的是元素，调用方才能把它们放进和交互元素同一个 id 注册表。正因如此
 *   `[i12]` 不用算任何坐标就能点——模型寻址图片和寻址按钮是一个路子，
 *   定位也从不依赖模型的像素估算。
 * - `textDescribed` 记的是 DOM 已经回答了“这是什么？”（alt、`aria-label`、
 *   `title`、`<figcaption>`、`<svg><text>`）。这些图片照样列出来，
 *   因为知道这儿有张图是有用的，但绝不能把它们送去识别：答案已经在文本里，
 *   多一次模型调用只会多花钱，还多一次跟答案打架的机会。
 *
 * @module
 */

import { isVisible, truncate } from './extract.ts'

/** 图片是怎么被发现的，这决定了以后能怎么读它。 */
export type ImageKind = 'img' | 'background' | 'svg' | 'poster'

/** 页面上发现的一张图片。 */
export interface ImageCandidate {
  /** 装着这张图片的元素（也就是点击目标）。 */
  element: Element
  kind: ImageKind
  /** 已知的最佳绝对 URL，图片没有可取地址时为 ''。 */
  src: string
  /** CSS 像素的渲染尺寸（或固有尺寸）；量不出来时为 0。 */
  width: number
  height: number
  /** alt / aria-label / title 文本，有的话。 */
  label: string
  /** 用来做上下文的简短邻近文本（标题或旁边的文案）。 */
  near: string
  /** 图片上方最近的一个标题：它所在的那块。 */
  heading: string
  /** DOM 文本已经说清这张图片时为 true。 */
  textDescribed: boolean
  /**
   * 浏览器试过加载这张图片、却没拿到可用内容时为 true。
   *
   * 加载失败的图片就算没什么可识别的也值得报：页面上明明摆着一个损坏图标或替代文本框，
   * 被告知“这儿本来有张图，但没加载出来”的模型，就不会凭空编一张。
   * 没有 alt 文本的加载失败图片不报——一个光秃秃的损坏框什么都说不出来，
   * 在广告多的页面上只是噪声。
   */
  failed: boolean
}

/** 小于这个尺寸的，就是占位符、图标或雪碧图碎片。 */
const MIN_IMAGE_SIDE = 32

/**
 * 一张图片的身份：它的绝对 URL，没有地址的图片则用占位符。
 *
 * 只在这里定义一次，因为两侧必须完全一致——快照报出身份，background 才能靠它查描述；
 * describe 操作则凭它请求描述。这条规则要是有第二份副本，就会慢慢飘成一个永远命不中的
 * 缓存。
 *
 * @param src - 绝对 URL，图片没有地址时为 ''。
 * @param index - 图片在清单里的索引。
 * @returns 身份。
 */
export function imageIdentity(src: string, index: number): string {
  return src !== '' ? src : `el:${String(index)}`
}

/**
 * 找背景图时，最多对多少个元素做样式检查。
 *
 * 背景图只能靠读计算样式找出来，而读计算样式会给每个候选元素强制一次布局。
 * 所以在超大页面上，元素总数是个糟糕的上界：扫描改成在固定个数处停下，
 * 不跟着文档规模一起涨。
 */
const BACKGROUND_SCAN_LIMIT = 1500

/** 每次快照最多留几张背景图（它们是最猜不准的一类）。 */
const MAX_BACKGROUND_IMAGES = 20

/** 每张图片留多少字符的周边文本。 */
const MAX_NEAR_CHARS = 60

/** 元素自身的文本，去掉首尾空白，给 `near` 和"有没有可复制的文本"用。 */
function ownText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 一段简短文本，告诉模型这张图片是关于什么的。
 *
 * 标题（caption）是作者自己的描述，所以优先用它；没有就用最近祖先元素的文本。
 * 只看可见文本：隐藏的标题描述的是用户看不到的图片。
 *
 * @param el - 图片元素。
 * @returns 最多 {@link MAX_NEAR_CHARS} 个字符，或者 ''。
 */
function nearbyText(el: Element): string {
  const figure = el.closest('figure')
  const caption = figure?.querySelector('figcaption')
  if (caption !== undefined && caption !== null && isVisible(caption)) {
    const text = truncate(ownText(caption), MAX_NEAR_CHARS).text
    if (text !== '') return text
  }
  let node: Element | null = el.parentElement
  for (let depth = 0; node !== null && depth < 3; depth += 1) {
    const text = truncate(ownText(node), MAX_NEAR_CHARS).text
    if (text !== '') return text
    node = node.parentElement
  }
  return ''
}

/** CSS 像素的尺寸；`<img>` 优先用固有尺寸。 */
function sizeOf(el: Element): { width: number; height: number } {
  const rect = el.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  return { width, height }
}

/** 已经带着文本替代的那些属性。 */
function labelOf(el: Element): string {
  for (const name of ['alt', 'aria-label', 'title']) {
    const value = el.getAttribute(name)
    if (value !== null && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * 计算后的 `background-image` 里的第一个 `url(...)`，有的话。
 *
 * @param el - 要检查的元素。
 * @returns 原始 URL；渐变和 `none` 时为 ''。
 */
function backgroundUrlOf(el: Element): string {
  const value = getComputedStyle(el).backgroundImage
  if (value === '' || value === 'none') return ''
  const match = /url\((['"]?)([^'")]+)\1\)/.exec(value)
  return match === null ? '' : match[2]
}

/**
 * DOM 文本是不是已经把这张图片是什么说清楚了。
 *
 * @param kind - 图片是怎么被发现的。
 * @param el - 图片元素。
 * @returns 识别带不来任何新信息时为 true。
 */
function isTextDescribed(kind: ImageKind, el: Element): boolean {
  if (labelOf(el) !== '') return true
  if (kind === 'svg') return el.querySelector('text') !== null
  if (kind === 'img') {
    const figure = el.closest('figure')
    return figure !== null && figure.querySelector('figcaption') !== null
  }
  return false
}

/** 把可能是相对值的属性解析成绝对 URL。 */
function absoluteUrl(value: string): string {
  if (value === '') return ''
  try {
    return new URL(value, document.baseURI).href
  } catch {
    return ''
  }
}

/**
 * 按文档顺序排在元素之前、离它最近的那个标题。
 *
 * 这就是图片所在的区块，也是页面能给出的最省事的消歧信息：“30%” 挂在
 * “本季度营收”底下和挂在“退款率”底下，意思完全不同。用文档顺序而不是祖先链，
 * 因为标题通常跟区块包裹元素是兄弟，而不是它的第一个子节点。
 *
 * @param el - 图片元素。
 * @param headings - 页面里的所有标题，按文档顺序。
 * @returns 标题文本（有上限）；图片排在所有标题之前时为 ''。
 */
function headingOf(el: Element, headings: readonly Element[]): string {
  let found = ''
  for (const heading of headings) {
    // FOLLOWING 表示 `el` 在 `heading` 之后；列表是有序的，
    // 所以最后一个仍在 `el` 之前的就是最近的。
    if ((heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) break
    found = ownText(heading)
  }
  return truncate(found, MAX_NEAR_CHARS).text
}

/** 某个根底下的标题，按文档顺序。 */
function headingsOf(root: Document | Element): Element[] {
  return [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
}

/**
 * 浏览器是不是已经试完加载、却一个像素都没出。
 *
 * 除了固有尺寸为零，还要求 `complete`：浏览器动手之前两者都是零，光凭尺寸判“失败”，
 * 会把还在加载的页面上的每张图片都标出来。非浏览器的 DOM（测试环境）从不设
 * `complete`，所以它的图片永远不会被报成失败。
 *
 * @param el - 图片元素。
 * @returns 加载已经结束、什么都没拿到时为 true。
 */
function failedToLoad(el: Element): boolean {
  if (el.tagName.toLowerCase() !== 'img') return false
  const image = el as HTMLImageElement
  return image.complete === true && image.naturalWidth === 0
}

/** 一张候选图片；元素不可用或太小时为 null。 */
function candidate(
  kind: ImageKind,
  el: Element,
  src: string,
  headings: readonly Element[],
): ImageCandidate | null {
  if (!isVisible(el)) return null
  const { width, height } = sizeOf(el)
  const label = labelOf(el)
  const failed = failedToLoad(el)
  // 尺寸下限滤掉占位符、图标和雪碧图碎片。加载失败的图片不在此列：
  // 它的盒子会塌成损坏图片的大小，下限会把一张作者已经命名的图片藏掉。
  // 所以只有它有名字时才留下。
  const tooSmall = width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE
  if (tooSmall && !(failed && label !== '')) return null
  return {
    element: el,
    kind,
    src,
    width,
    height,
    label,
    near: nearbyText(el),
    heading: headingOf(el, headings),
    textDescribed: isTextDescribed(kind, el),
    failed,
  }
}

/**
 * 每一张值得报出来的图片，按文档顺序。
 *
 * @param root - 要扫的 document（或区域）。
 * @returns 候选项，按元素去重。
 */
export function collectImages(root: Document | Element): ImageCandidate[] {
  const found: ImageCandidate[] = []
  const seen = new Set<Element>()
  const headings = headingsOf(root)

  const push = (value: ImageCandidate | null): void => {
    if (value === null || seen.has(value.element)) return
    seen.add(value.element)
    found.push(value)
  }

  for (const el of root.querySelectorAll('img')) {
    // `currentSrc` 才是浏览器真从 `srcset` 里挑出来的那个；
    // `src` 只是兜底，可能是更小的变体。
    const src = absoluteUrl((el as HTMLImageElement).currentSrc || el.getAttribute('src') || '')
    push(candidate('img', el, src, headings))
  }

  for (const el of root.querySelectorAll('video[poster]')) {
    push(candidate('poster', el, absoluteUrl(el.getAttribute('poster') ?? ''), headings))
  }

  for (const el of root.querySelectorAll('svg')) {
    // 套在另一个 `<svg>` 里的 `<svg>`，属于父元素渲染的一部分。
    if (el.parentElement?.closest('svg') !== null && el.parentElement?.closest('svg') !== undefined) continue
    push(candidate('svg', el, '', headings))
  }

  let scanned = 0
  let backgrounds = 0
  for (const el of root.querySelectorAll('*')) {
    if (scanned >= BACKGROUND_SCAN_LIMIT || backgrounds >= MAX_BACKGROUND_IMAGES) break
    scanned += 1
    if (seen.has(el)) continue
    const tag = el.tagName.toLowerCase()
    if (tag === 'img' || tag === 'svg' || tag === 'video' || tag === 'script' || tag === 'style') continue
    const url = backgroundUrlOf(el)
    if (url === '') continue
    const value = candidate('background', el, absoluteUrl(url), headings)
    if (value === null) continue
    backgrounds += 1
    push(value)
  }

  return found
}
