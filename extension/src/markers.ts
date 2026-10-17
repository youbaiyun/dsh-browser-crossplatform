/**
 * 图像标记格式，写标记的 content script 和填标记的 background 共用。
 *
 * 格式放在这里、跟 DOM 分开，有两个原因。两边必须完全一致——填充那一步要是认不出
 * 渲染方写下的东西，模型读到的就是原始标点。再者 background 是个完全没有 DOM 的
 * service worker，所以它得导得进这个格式，又不至于把读页面的代码拖进 worker。
 *
 * 标记必须做不了假。页面自己的文本，正是模型被要求不予采信的东西，
 * 所以一个能写出 `⟦i12 img:已付款⟧` 的页面，就可能把自编的描述塞给模型。
 * 因此每条页面产生的字符串都要剥掉方括号；方括号也是特意挑的，
 * 真实文本里几乎不会出现。
 *
 * @module
 */

/** 标记方括号（数学白色方括号）。 */
const OPEN = '\u27e6'
const CLOSE = '\u27e7'

/** 全部标记字符，用来从页面文本里剥离。 */
const MARKER_CHARS = /[\u27e6\u27e7]/g

/** 一个标记，连同它此刻携带的状态。 */
const MARKER_PATTERN = /\u27e6i(\d+) img:([^\u27e7]*)\u27e7/g

/** 还没对图像提出任何询问时，标记携带的状态。 */
export const IMAGE_STATE_UNREQUESTED = 'not-requested'

/**
 * 把页面产生的文本里的标记方括号去掉。
 * @param text - 来自页面的文本。
 * @returns 去掉所有方括号后的同一段文本。
 */
export function escapeMarkers(text: string): string {
  return text.replace(MARKER_CHARS, '')
}

/**
 * content script 为一张图像写下的标记。
 *
 * 状态是 `not-requested`：渲染那一刻这是实话，而且就算填充那一步压根没跑，
 * 它读起来也还像句话。放个 `?` 占位符比完全没有标记更糟——模型只能去猜它是什么意思。
 *
 * @param index - 该图像在清单里的索引。
 * @returns 标记文本。
 */
export function imageMarker(index: number): string {
  return `${OPEN}i${String(index)} img:${IMAGE_STATE_UNREQUESTED}${CLOSE}`
}

/**
 * 把每个标记连同它携带的状态一起移除。
 *
 * 在拿渲染后的文本当页面文本用之前必须这么做。填好的标记里装着模型的描述，
 * 不剥掉的话，一段提到数字的描述就会被跨模态校验拿去跟它自己比——
 * 这种比较永远一致，什么都验证不出来。
 *
 * @param text - 可能含标记的渲染后文本。
 * @returns 每个标记都被完整移除后的文本。
 */
export function stripMarkers(text: string): string {
  MARKER_PATTERN.lastIndex = 0
  return text.replace(MARKER_PATTERN, '')
}

/**
 * 文本里带没带标记。
 * @param text - 要检查的文本。
 * @returns 有标记时为 true。
 */
export function hasMarkers(text: string): boolean {
  MARKER_PATTERN.lastIndex = 0
  return MARKER_PATTERN.test(text)
}

/**
 * 把每个标记的状态换掉。
 *
 * 没填上的标记会变成 `not-requested`，所以哪怕填充那一步从没跑过，
 * 留给模型的也是一句它能据此行动的话，不是一个占位符。
 *
 * @param text - 含标记的渲染后文本。
 * @param stateOf - 某个图像索引对应的状态；不知道时给 undefined。
 * @returns 每个标记都填好后的文本。
 */
export function fillMarkers(text: string, stateOf: (index: number) => string | undefined): string {
  return text.replace(MARKER_PATTERN, (_whole, digits: string) => {
    const state = stateOf(Number(digits)) ?? IMAGE_STATE_UNREQUESTED
    return `${OPEN}i${digits} img:${state}${CLOSE}`
  })
}
