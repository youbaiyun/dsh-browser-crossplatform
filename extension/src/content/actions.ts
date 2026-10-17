/**
 * 页面操作：click/type/press/scroll/navigate/get_text/wait，在 content script 里对真实
 * 页面执行（保留登录状态），每个操作回一段简短的状态文本。导航会返回一份全新的完整快照，
 * 因为文档——以及 id 注册表——会重置。
 *
 * 浏览器操作的结果一律是结构化文本，一行状态就能告诉模型发生了什么、还剩什么状态。
 *
 * @module
 */

import { pageText, truncate } from './extract.ts'
import type { ElementIds } from './ids.ts'
import { collectImages, imageIdentity, type ImageCandidate } from './images.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot } from './snapshot.ts'

/**
 * 一张图片，background 描述它需要的字段都已经解析好了。
 *
 * `identity` 既是缓存键，也是协议的请求标识：两行显示的是同一个 logo 时共用它，所以一个
 * 页面只为一次描述付费，而不是三十次。
 */
export interface ImageTarget {
  identity: string
  alt: string
  near: string
  heading: string
  /** 协议词汇：content、icon、link、button、background 或 canvas。 */
  kind: string
  /** 绝对 URL；没有可抓取地址的图片是 ''。 */
  src: string
}

/** 某张已编号图片的 identity，给 background 查它的状态用。 */
export interface ImageIdentity {
  index: number
  identity: string
  /**
   * 页面已经知道这张图读不了时置上，比如图片加载失败。失败的图片绝不会被请求，所以它
   * 永远不会有缓存条目，原因只可能来自这里。
   */
  unavailable?: string
}

/** 一次已经出了结果的操作。 */
export interface ActionResult {
  text: string
  /** 页面自己生成的快照 delta；background 必须按不可信内容包装它。 */
  pageContent?: string
  /** 回完这次响应之后，同一个 frame 里已经排了一次文档导航。 */
  navigationPending?: boolean
  /** 本次操作解析出的图片，给视觉流水线用。 */
  image?: ImageTarget
  /**
   * 本结果编过号的那些图片的 identity。
   *
   * 文本里的标记给的是 index，描述缓存却按 identity 存。没有这个映射，background 就得
   * 从自己渲染出的文本里把 URL 再解析回来，才能把两边对上。
   */
  imageIdentities?: ImageIdentity[]
}

/** 一次操作在返回之前，要盯着文档就绪多久。 */
export interface PageSettlePolicy {
  /** 文档就绪之后最早能返回的时刻。 */
  minimumMs: number
  /** 返回之前要求 DOM 安静多久。 */
  quietMs: number
  /** 就绪之后的硬上限；一直在播动画的页面不能把工具拖住。 */
  maxAfterReadyMs: number
  /** 等文档就绪期间的硬上限。 */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** 让自动操作的上下文保持聚焦，同时留住协商好的完整快照预算。 */
const ACTION_DELTA_MAX_CHARS = 4_000

/**
 * 等文档就绪，再等一段没有变更的窗口。过去那个固定延迟对每个操作一样收费，可一次迟到的
 * DOM 更新正好落在边界附近时，它还是返回得太早。这个观察器在本来就稳的页面上提前返回，
 * 只有真变了才延长，遇上一直在动的页面也不会没完没了。
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 一个 `browser_wait` 条件在失败之前，最多能一直不满足多久。
 *
 * 这个上限是刻意加的，比 bridge 自己的 90s 单次调用预算还短：条件跑在 content script 里，
 * 而 `chrome.runtime` 消息捎不了 `AbortSignal`，所以工具调用被取消也中断不了这个循环——
 * 调用方不等了，轮询却会一路跑到截止时间。截止时间设短就把这点限制住了，也不亏任何正当
 * 用法：一个想着撑过十秒的等待，等的本来就是页面绝不会做的事。
 */
const WAIT_CONDITION_TIMEOUT_MS = 10_000

/**
 * 调用方传进来的等待预算的上限。
 *
 * 离 bridge 的 90s 单次调用超时还远，所以一次等待活得不可能比请求它的那次调用更久；也够
 * 低，免得有人拿这个值无限期占住一个工具槽位。
 */
export const WAIT_MAX_BUDGET_MS = 60_000
/** 等待条件的轮询间隔；短到感觉是即时的，又便宜到能一直轮下去。 */
const WAIT_POLL_MS = 100

/**
 * 等某个条件成立，然后返回。
 *
 * 永远不成立的条件算失败，不是默默成功：模型得知道页面从没产出它等的那个东西，才好决定
 * 继续等还是放弃。协议里的 `timeout` code 就是干这个的，这里也因此抛异常而不是直接返回。
 *
 * @param description - 等的是什么，写进错误消息。
 * @param budgetMs - 继续轮询多久。
 * @param satisfied - 每轮都重新求一次值。
 * @throws 过了截止时间就抛 code 为 `timeout` 的 ActionError。
 */
async function waitUntil(description: string, budgetMs: number, satisfied: () => boolean): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (satisfied()) return
    if (Date.now() >= deadline) {
      throw new ActionError('timeout', `Timed out after ${budgetMs}ms waiting for ${description}.`)
    }
    await sleep(WAIT_POLL_MS)
  }
}

function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current indices.`)
  }
  return el
}

/** 带着稳定 wire code 的错误。 */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** 和 React 对得上的赋值方式：原生 setter，再补 input/change 事件。 */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 各个操作的实现；每个都返回一段文本结果。 */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** 只有 background 不用再审批就能共享页面内容时才开。 */
  includePageDelta?: boolean
}

/** 按参数跑一个指定名字的操作。 */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args)
    case 'browser_describe_image':
      return describeImageAction(args, ctx)
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  // 每次快照都刷新基线，delta 调用才有得比——不管上一次是不是 delta。
  const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return { text: renderSnapshot(view, delta), imageIdentities: imageIdentitiesOf(view) }
}

/** 一个视图里已编号图片的 identity，给 background 查。 */
function imageIdentitiesOf(view: ReturnType<typeof buildSnapshot>): ImageIdentity[] {
  return view.images.map((image) => ({
    index: image.index,
    identity: image.identity,
    ...image.unavailable === undefined ? {} : { unavailable: image.unavailable },
  }))
}

/** 模块级的最近一次快照状态，delta 模式靠它（只在 content script 活着期间有效）。 */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** 导航之后（换了新文档）把 delta 状态作废。 */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** 附上这次结算出来的页面变化，同时把完整视图留作下一次 delta 的基线。 */
function withPageDelta(text: string, ctx: ActionContext): ActionResult {
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
    imageIdentities: imageIdentitiesOf(view),
  }
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const el = elementOrThrow(ctx.ids, index)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (el instanceof HTMLAnchorElement) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* 让原生点击去处理不寻常的链接 */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // 手动赋 location 保不住浏览器管的那些链接语义，比如 referrer 抑制、超链接审计、
      // 归因登记。这类链接还是让浏览器原生激活，但别声称一定换来一个新文档：SPA 照样可能
      // 取消这次点击、留在本文档里。
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: `Clicked link [${index}] using native browser activation. Call browser_snapshot to read the resulting state.`,
        }
      }
      // 派发 click，但不带默认导航，这样客户端路由器能同步取消、留在本文档里。
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      // 跨文档导航可能在任何 await 结算之前就把这个 content script 卸掉。所以先回话，
      // 下一个任务里再导航。
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link [${index}]. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link [${index}]. The link may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button [${index}] is disabled.`)
  }
  ;(el as HTMLElement).click()
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked [${index}].`, ctx)
}

/**
 * 最近的可编辑宿主；被 `contenteditable="false"` 孤岛挡住编辑时返回 null。
 *
 * 往上找必须停在最近的 `[contenteditable]` 边界上，不能跳过被禁用的那些：可编辑输入框里
 * 嵌着不可编辑孤岛，孤岛里的元素就归那个孤岛，越过它去解析只会把文本敲进外层输入框，
 * 而不是拒绝这个目标。
 *
 * @param el - 操作寻址的元素。
 * @returns 拥有它的可编辑宿主；编辑被挡住时为 null。
 */
function editingHost(el: HTMLElement): HTMLElement | null {
  const boundary = el.closest('[contenteditable]')
  if (!(boundary instanceof HTMLElement)) return null
  return boundary.getAttribute('contenteditable') === 'false' ? null : boundary
}

/**
 * 这个元素能不能接收富文本输入。
 *
 * `isContentEditable` 是浏览器自己的答案；边界查找补的是属性那条路，而它在 jsdom 里没有
 * 实现，这些测试恰好跑在 jsdom 上。
 *
 * @param el - 操作寻址的元素。
 * @returns 元素能接收富文本输入时为 true。
 */
function isEditable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (el.isContentEditable || editingHost(el) !== null)
}

/**
 * 走浏览器自己的编辑流水线，把文本插进富文本宿主。
 *
 * Lexical、Draft.js、ProseMirror 这类编辑器有自己的文档模型，外来的 DOM 写入会被它们
 * 调和掉，赋值 `textContent` 于是悄悄落空，调用方报的成功也就成了假话。
 * `execCommand('insertText')` 虽然废弃了，却仍是唯一能产出那些编辑器监听的
 * `beforeinput`/`input` 序列的路子。宿主不支持它就退回直接写入。
 *
 * @param el - 操作寻址的元素。
 * @param text - 要插入的文本。
 * @param replace - 是否替换宿主当前的内容。
 */
function typeIntoContentEditable(el: HTMLElement, text: string, replace: boolean): void {
  // `isEditable` 已经挡掉了被禁用的孤岛，所以这里宿主为 null 说明该元素没有那个属性
  // 也可编辑；那就直接对它寻址。
  const host = editingHost(el) ?? el
  host.focus()
  const selection = host.ownerDocument.getSelection()
  if (selection !== null) {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host)
    // 折叠到末尾就是追加；整个选区则会被 insertText 替换掉。
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const doc = host.ownerDocument
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text)) return
    } catch {
      // 落到下面的直接写入路径。
    }
  }
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const el = elementOrThrow(ctx.ids, index)

  // `<select>` 和 checkbox 都不是文本字段，可模型拿到的那个工具三者通吃：快照会把它们
  // 列出来，"往里输入"就是模型自然的选择。先按 value 匹配，再按可见 label，最后按 1 起始
  // 的序号——人依次尝试的顺序也正是这个。
  if (el instanceof HTMLSelectElement) {
    const chosen = chooseOption(el, text)
    if (chosen === undefined) {
      // 把 label 一起列出来，光给 value 不够：像 `a` 这样的 value 说明不了选中了什么，
      // 而这条消息就是为了让人能照着做。
      const available = [...el.options].slice(0, 20).map((option, position) => {
        const label = option.text.trim()
        return label !== '' && label !== option.value
          ? `${String(position + 1)}. ${option.value} (${label})`
          : `${String(position + 1)}. ${option.value || label}`
      })
      throw new ActionError('action-failed', `Element [${index}] has no option matching "${text}". Available: ${available.join(', ')}${el.options.length > 20 ? ', …' : ''}.`)
    }
    // 走 option 自己的 `selected`，然后还得通知页面：框架听的是 `change`，直接赋
    // `select.value` 不会派发它。
    for (const option of el.options) option.selected = option === chosen
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await waitForPageSettled(TYPE_SETTLE)
    return withPageDelta(`Selected "${chosen.text.trim() || chosen.value}" in [${index}].`, ctx)
  }

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const wanted = parseCheckboxValue(text)
    if (wanted === undefined) {
      throw new ActionError('bad-args', `Element [${index}] is a ${el.type}; pass true or false as text to set it.`)
    }
    if (el.disabled) {
      // 被禁用的控件根本不接受点击，报告请求的那个状态就是编造。`<button disabled>`
      // 也是同一个道理，直接拒绝。
      throw new ActionError('action-failed', `Element [${index}] is disabled; the page decides when it may be changed.`)
    }
    if (el.type === 'radio' && wanted === false && el.checked) {
      // radio 靠点击取消不了选中——一组里总得有一个被选中——所以老实点拒绝，
      // 而不是回一句 "Unchecked"。
      throw new ActionError('action-failed', `Element [${index}] is a radio and cannot be unchecked directly; check another radio in its group instead.`)
    }
    // 用 `click()`，别直接赋 `checked`：它会触发页面监听的那些事件，对 radio 来说还能
    // 在组内挪动选中项。
    if (el.checked !== wanted) el.click()
    await waitForPageSettled(TYPE_SETTLE)
    if (el.checked !== wanted) {
      // 页面可能不认这次变更（只读控件、把值改回去的 handler）。报实际发生了什么，
      // 别报请求了什么。
      throw new ActionError('action-failed', `Element [${index}] did not accept the change; it is still ${el.checked ? 'checked' : 'unchecked'}.`)
    }
    return withPageDelta(`${wanted ? 'Checked' : 'Unchecked'} [${index}].`, ctx)
  }

  if (isEditable(el)) {
    typeIntoContentEditable(el, text, replace)
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  } else {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into [${index}].`, ctx)
}

/**
 * `<select>` 该切到的那个 option；没匹配上就返回 undefined。
 *
 * 依次试 value → 可见 label → 1 起始的位置，比较都在 trim 过的文本上做、也不区分大小写，
 * 所以 `true`/`True`、以及 label 里多一个换行，都能对上。
 */
function chooseOption(select: HTMLSelectElement, text: string): HTMLOptionElement | undefined {
  const wanted = text.trim().toLowerCase()
  const options = [...select.options]
  return options.find((option) => option.value.trim().toLowerCase() === wanted)
    ?? options.find((option) => option.text.trim().toLowerCase() === wanted)
    ?? (/^\d+$/u.test(wanted) ? options[Number(wanted) - 1] : undefined)
}

/** checkbox 或 radio 的 `true`/`false`，以及常见的同义词。 */
function parseCheckboxValue(text: string): boolean | undefined {
  const value = text.trim().toLowerCase()
  if (['true', '1', 'on', 'yes', 'checked'].includes(value)) return true
  if (['false', '0', 'off', 'no', 'unchecked'].includes(value)) return false
  return undefined
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  if (key === 'Enter' && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${key}".`, ctx)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  switch (direction) {
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' })
      break
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      break
    case 'up':
      window.scrollBy({ top: -amount, behavior: 'instant' })
      break
    case 'down':
      window.scrollBy({ top: amount, behavior: 'instant' })
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.`, ctx)
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // 跨文档导航会卸掉这个 content script，并在任何 await 结算之前就把
  // tabs.sendMessage 的响应 port 销毁——所以先回话，再到新任务里导航。
  // 模型会在加载完成后重新快照。
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  // 和 navigate 一样：先响应再导航（文档一卸载，响应端口就没了）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
  const truncated = truncate(text, 8_000)
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters.)` : '') }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  // 延迟和条件预算都封了顶：bridge 到自己的超时就放弃这次调用，而一个大到溢出的调用方
  // 数字（`1e999` 会解析成 Infinity）绝不能把轮询变成死循环。
  const rawMs = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  const ms = Math.min(rawMs, WAIT_MAX_BUDGET_MS)
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  // `pageText` 会把连续空白折成一个空格，needle 就得照样折一遍，否则多行的 label 永远
  // 匹配不上 haystack。
  const wanted = typeof args.text === 'string' && args.text !== '' ? args.text.replace(/\s+/gu, ' ').trim() : undefined
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)

  // 条件就是对模型的承诺：页面确实会产出它要的东西；页面始终不产出时，用 `timeout` 失败
  // 正是提这个问题的意义所在。没有条件时还是老样子：先结算，再补一段可选的延迟。
  if (selector !== undefined) {
    await waitUntil(`selector "${selector}" to match`, ms > 0 ? ms : WAIT_CONDITION_TIMEOUT_MS, () => document.querySelector(selector) !== null)
  } else if (wanted !== undefined) {
    await waitUntil(`text "${wanted}" to appear`, ms > 0 ? ms : WAIT_CONDITION_TIMEOUT_MS, () => pageText(document.body).includes(wanted))
  } else if (ms > 0) {
    await sleep(ms)
  }

  const described = selector !== undefined
    ? `selector "${selector}" matched`
    : wanted !== undefined ? `text "${wanted}" appeared` : 'the page is stable'
  return withPageDelta(`Waited until ${described}${ms > 0 && (selector !== undefined || wanted !== undefined) ? ` (within ${ms}ms)` : ''}.`, ctx)
}

/**
 * 按清单里的序号解析出一张图片，给视觉流水线用。
 *
 * content script 是唯一能看到页面的角色，所以它只答这张图的 identity 和上下文，别的不管：
 * 抓字节、和模型对话都是 background 的事，页面从不需要描述自己。
 *
 * 序号是相对产出它的那份文档说的，一次重渲染就把这个前提打破了：id 挂着的 DOM 节点被换掉，
 * 注册表让这个 id 退役，模型记住的编号于是解析不到任何东西。以前哪怕图片一动没动，这次
 * 调用也会就此结束。`identity` 是 background 对那个编号曾经指向什么的记忆，图片因此能按
 * 地址找回来，而不是靠一个已经漂了的编号。
 *
 * @param args - 工具参数（`index`，加上 background 的 `identity`）。
 * @param ctx - id 注册表，用来解析序号。
 * @returns 一行状态，加上解析出的图片。
 */
function describeImageAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const index = numberArg(args, 'index')
  const element = ctx.ids.elementByIndex(index)
  /**
   * 至多采集一次，而且只在真需要这份列表时才采。
   *
   * 采集会为找背景图强制布局最多 1500 个元素，所以正常解析出序号的调用不该为了一次
   * 它遇不到的失败去准备措辞，就付这个代价。
   */
  let collected: ImageCandidate[] | undefined
  const images = (): ImageCandidate[] => (collected ??= collectImages(document))

  let image = element === undefined ? undefined : images().find((candidate) => candidate.element === element)
  let recovered = false
  if (element === undefined && isAddressHint(args.identity)) {
    // 必须唯一匹配才算恢复。一个地址被许多图块复用——共用的 logo、占位图——时取第一个，
    // 交给模型的就是错的 `alt`、`near` 和 `heading`，而这张图的答案还没缓存；给错图块错
    // 描述，比直接清楚地失败更糟。
    const matches = images().filter((candidate) => matchesRememberedIdentity(candidate, args.identity))
    if (matches.length === 1) {
      image = matches[0]
      recovered = true
    }
  }
  if (image === undefined) {
    throw new ActionError('action-failed', element === undefined
      ? imageIndexFailure(index, images, ctx)
      : `Element [${index}] is not an image that browser_snapshot listed.`)
  }
  // 缓存键和请求 identity 是同一个值，正因如此，一个有三十个相同 logo 的页面只为一次
  // 描述付费，而不是三十次。这条规则写在 `imageIdentity` 里，所以快照报出来的是完全一样
  // 的字符串。
  const identity = imageIdentity(image.src, index)
  const current = ctx.ids.indexOf(image.element)
  return {
    text: `Image [${index}] resolved: ${image.kind} ${String(image.width)}x${String(image.height)}`
      + `${image.label === '' ? '' : ` "${image.label}"`}`
      + `${recovered
        ? ` — recovered by address after the page changed; it is now index [${current === undefined ? 'unlisted' : String(current)}]`
        : ''}`,
    image: {
      identity,
      alt: image.label,
      near: image.near,
      heading: image.heading,
      kind: protocolKind(image, image.element),
      src: image.src,
    },
  }
}

/**
 * 被记住的 identity 是不是一个能拿来匹配的地址。
 *
 * 只有绝对地址算数。没有地址的图片靠清单编号标识，而失效的恰恰就是这个编号，照它匹配等于
 * 编一个答案出来，而不是恢复答案。
 *
 * @param identity - background 记住的那个编号曾经指向什么。
 * @returns 是地址时为 true。
 */
function isAddressHint(identity: unknown): identity is string {
  return typeof identity === 'string' && identity !== '' && !identity.startsWith('el:')
}

/**
 * 采集到的这张图片是不是被记住的 identity 指的那张。
 *
 * @param image - 一个采集到的候选项。
 * @param identity - background 记住的那个编号曾经指向什么。
 * @returns 是这张图片时为 true。
 */
function matchesRememberedIdentity(image: ImageCandidate, identity: unknown): boolean {
  return isAddressHint(identity) && image.src === identity
}

/**
 * 一个序号为什么没解析出来，以及现在哪些编号能解析。
 *
 * 读者真正见过的编号排在前面：实时重扫数出来的图片比快照 `Images` 小节里的多得多，而点一个
 * 在读者自己的快照里压根不存在的编号，不是它能走的下一步。重扫是留给还没快照过的文档的
 * 回退。
 *
 * @param index - 失败的那个编号。
 * @param images - 惰性采集，快照答不上来时才查。
 * @param ctx - id 注册表，用来取当前编号。
 * @returns 该消息。
 */
function imageIndexFailure(index: number, images: () => ImageCandidate[], ctx: ActionContext): string {
  const numbered = lastSnapshot === null ? [] : lastSnapshot.images.map((view) => view.index)
  const current = numbered.length > 0
    ? numbered
    : images()
      .map((candidate) => ctx.ids.indexOf(candidate.element))
      .filter((id): id is number => id !== undefined)
  const listed = current.length === 0
    ? 'the page currently numbers no images'
    : `the page currently numbers images ${current.slice(0, 20).join(', ')}`
  return `Element [${index}] does not exist; the page may have changed, and ${listed}. Call browser_snapshot for a full refresh.`
}

/**
 * 把采集那边的类别映射成协议用的词。
 *
 * 采集说的是怎么找到这张图的（`img`、`svg`、`poster`、`background`）；识别请求说的是它在
 * 页面里是什么（content、icon、link、button、background、canvas），因为决定答案怎么读的是
 * 后者。
 *
 * @param image - 采集到的候选项。
 * @param element - 它的元素。
 * @returns 协议类别。
 */
function protocolKind(image: ImageCandidate, element: Element): string {
  if (image.kind === 'background') return 'background'
  if (element.closest('a[href]') !== null) return 'link'
  if (element.closest('button, [role="button"]') !== null) return 'button'
  return 'content'
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
