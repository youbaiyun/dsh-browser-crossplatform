/**
 * 纯文本页面快照：模型看到的页面全貌。
 *
 * 浏览器工具走文本快照，所以这里把页面渲染成严格卡字符预算的结构化文本：URL/标题、正文、
 * 带编号的交互元素清单、表单字段（敏感值已掩码）、带编号的图片清单。图片只描述、绝不传像素，
 * 负载因此始终是文本，模型却仍能知道这儿有张图、它的替代文本说了什么、哪个索引指向它。
 * `delta` 模式只返回上次快照之后变了的那些，稳定的元素 id 则让模型的寻址在多次快照之间
 * 一直有效。
 *
 * @module
 */

import { annotatedText } from './annotate.ts'
import { imageMarker } from '../markers.ts'
import { accessibleName, collectInteractive, isInViewport, isVisible, mainRoot, truncate } from './extract.ts'
import { ElementIds } from './ids.ts'
import { collectImages, imageIdentity } from './images.ts'
import { isSensitiveField, maskValue } from './privacy.ts'

/** 每种元素类型对应的角色标签（模型看到的词）。 */
function roleOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      default: return 'input'
    }
  }
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable'
  return el.tagName.toLowerCase()
}

/** 一个带编号的交互元素。 */
interface InventoryItem {
  index: number
  role: string
  name: string
  disabled?: boolean
  checked?: boolean
  selected?: boolean
  href?: string
  inViewport: boolean
}

/** 一个带编号的表单字段，含它的值（已掩码）。 */
interface FormFieldView {
  index: number
  label: string
  kind: string
  value: string
  masked: boolean
  checked?: boolean
  required?: boolean
}

/** 一张带编号的图片：只给文字描述，不传像素。 */
interface ImageView {
  index: number
  kind: string
  width: number
  height: number
  /** alt / aria-label / title，作者给了哪个就是哪个。 */
  label: string
  /** 简短标题或邻近文本，用来给点上下文。 */
  near: string
  /** 同源路径，或者 host+path——图片有地址时才有。 */
  src: string
  /**
   * 图片的身份，形式和 describe 操作用的一样。
   *
   * 永远不渲染：它是 background 查这张图描述用的键，而把 URL 在每一行重复一遍，等于把
   * 文本预算花在路径本来就带着的信息上。
   */
  identity: string
  /** DOM 文本已经描述过这张图时为 true。 */
  textDescribed: boolean
  /**
   * 页面知道的话，说明这张图为什么读不了。
   *
   * 这是 content script 上报的，不是从缓存里查的，因为它是页面自己的属性：请求压根没发生，
   * 也就永远不会有对应的缓存条目。
   */
  unavailable?: string
}

/** 一次页面快照。 */
export interface SnapshotView {
  version: number
  url: string
  title: string
  ready: 'complete' | 'loading'
  main: string
  items: InventoryItem[]
  forms: FormFieldView[]
  images: ImageView[]
  /** 上次快照以来变过的 id（delta 模式）。 */
  changed: number[]
  /** 上次快照以来没了的 id（delta 模式）。 */
  removed: number[]
  /** 清单被重新编号时为 true（模型得重新读一遍 id）。 */
  reindexed: boolean
  /** 预算账：正文裁掉了多少字符，以及撞上数量上限被丢掉的 items/forms/images。 */
  truncated: { mainChars: number; itemsDropped: number; formsDropped: number; imagesDropped: number }
  /** 总预算（渲染时封顶用）。 */
  budgetChars: number
}

/** 快照预算：握手时和插件按上限协商出来的。 */
export interface SnapshotBudget {
  maxItems: number
  maxForms: number
  maxChars: number
}

/** 构建一次快照的选项。 */
export interface SnapshotOptions {
  delta?: boolean
  region?: string
  budget: SnapshotBudget
}

/** 链接的标题行：同源给相对路径，否则给 host + path。 */
function hrefHeadline(href: string): string {
  try {
    const url = new URL(href, document.baseURI)
    return url.origin === location.origin ? `${url.pathname}${url.search}` : `${url.host}${url.pathname}`
  } catch {
    return href
  }
}

/**
 * 有没有哪个祖先用 opacity 把这棵子树藏起来了。
 *
 * `opacity` 不继承，所以淡出子树里的元素照样报自己 `opacity: 1`，矩形也还是非零。可关闭的
 * 模态框在关闭过程中、或者预渲染的时候就是这样，因此光看对话框自己会把它当成打开，让它那些
 * 看不见的控件把真在屏幕上的控件挤掉。
 *
 * 遍历覆盖每一个 `Element`，不限于 HTML：HTML dialog 可能待在 SVG 的 `foreignObject` 里，
 * 而把整棵子树淡出的 SVG 祖先一样能把它藏住。这里不用管 `display: none` 和
 * `visibility: hidden`：前者会让 `isVisible` 已经量过的矩形塌掉，后者会继承，所以早就体现在
 * 对话框自己的计算样式里了。
 *
 * @param el - 候选元素。
 * @returns 没有任何祖先让子树淡出时为 true。
 */
function ancestorsRendered(el: Element): boolean {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).opacity === '0') return false
  }
  return true
}

/**
 * 做一个记住答案的“这个对话框开着吗？”判断。
 *
 * 开没开只取决于对话框自己，所以祖先遍历对每个对话框只算一次，而不是每个候选元素都算一遍。
 *
 * @returns 一个作用在对话框元素上的谓词。
 */
function openDialogTest(): (dialog: Element) => boolean {
  const seen = new Map<Element, boolean>()
  return (dialog) => {
    let open = seen.get(dialog)
    if (open === undefined) {
      open = isVisible(dialog) && ancestorsRendered(dialog)
      seen.set(dialog, open)
    }
    return open
  }
}

/**
 * 元素所属的那个已打开模态框，有的话。
 *
 * 模态框会把后面的一切都变成惰性的，所以它的控件才是真正的交互表面。它还往往在 DOM 里追加得
 * 比较晚，不提升上来就会被挤到清单上限之外——那些控件恰恰是调用方要的。已关闭的预渲染对话框
 * 不可见，绝不能被提升。
 *
 * @param el - 候选元素。
 * @param isOpen - 作用在对话框元素上、会记住答案的打开判断。
 * @returns 所属的已打开对话框，或 null。
 */
function openDialogOf(el: Element, isOpen: (dialog: Element) => boolean): Element | null {
  const dialog = el.closest('[role="dialog"], [aria-modal="true"]')
  return dialog !== null && isOpen(dialog) ? dialog : null
}

/**
 * 构建当前页面的快照。
 *
 * 这里要把稳定的 id 注册表、清单收集（对话框优先，其次视口内的优先，都受上限约束）、正文提取
 * （受预算约束）串起来，delta 模式下还要和上一次快照做 diff。
 *
 * @param ids - 稳定的 id 注册表（每个 content script 生命周期一份）。
 * @param options - delta 标志、区域选择器和协商好的预算。
 * @param last - 上一次的快照视图，首次快照时为 null。
 * @returns 快照视图。
 */
export function buildSnapshot(ids: ElementIds, options: SnapshotOptions, last: SnapshotView | null): SnapshotView {
  const elements = collectInteractive(document)
  const images = collectImages(document)
  // 图片和交互元素进同一个注册表，图片才得以成为一等的点击目标：模型按索引寻址图片，跟寻址
  // 按钮一样，中间不需要哪一步靠模型估摸屏幕位置。
  const { added, removed } = ids.assign([...elements, ...images.map((image) => image.element)])
  // 重新编号只有相对上一次快照才说得上：新文档的头一次快照必然把什么都算新加。
  const tracked = elements.length + images.length
  const reindexed = last !== null && added + removed > tracked * 0.5

  // 视口和对话框归属只量一次。在排序比较函数里调 getBoundingClientRect，会让大页面反复
  // 强制读取布局。
  const isOpenDialog = openDialogTest()
  const elementViews = elements.map((element) => ({
    element,
    inViewport: isInViewport(element),
    inDialog: openDialogOf(element, isOpenDialog) !== null,
  }))
  const ordered = [...elementViews].sort((a, b) =>
    Number(b.inDialog) - Number(a.inDialog) || Number(b.inViewport) - Number(a.inViewport))
  const names = new Map<Element, string>()
  const nameOf = (element: Element): string => {
    let name = names.get(element)
    if (name === undefined) {
      name = accessibleName(element)
      names.set(element, name)
    }
    return name
  }

  const items: InventoryItem[] = []
  for (const { element: el, inViewport } of ordered.slice(0, options.budget.maxItems)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const item: InventoryItem = {
      index,
      role: roleOf(el),
      name: nameOf(el),
      inViewport,
    }
    if (el instanceof HTMLButtonElement && el.disabled) item.disabled = true
    if (el instanceof HTMLInputElement) {
      if (el.disabled) item.disabled = true
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked
    }
    const ariaChecked = el.getAttribute('aria-checked')
    if (ariaChecked === 'true' || ariaChecked === 'false') item.checked = ariaChecked === 'true'
    if (el instanceof HTMLOptionElement && el.selected) item.selected = true
    if (el instanceof HTMLAnchorElement && el.href !== '') item.href = hrefHeadline(el.href)
    items.push(item)
  }

  // 表单控件本来就属于可见的交互清单，直接复用那次扫描，别再查一遍、算一遍样式、量一遍。
  const formElements = elements.filter((el) => el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement)
  const forms: FormFieldView[] = []
  for (const el of formElements.slice(0, options.budget.maxForms)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const masked = isSensitiveField(el)
    const checkable = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
    const value = checkable
      ? ''
      : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el instanceof HTMLSelectElement
        ? selectedText(el)
        : ''
    forms.push({
      index,
      label: nameOf(el),
      kind: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
      value: masked ? maskValue(value) : value.slice(0, 120),
      masked,
      ...checkable ? { checked: el.checked } : {},
      ...el instanceof HTMLInputElement && el.required ? { required: true } : {},
    })
  }

  // 图片和元素共用一份预算，不另开一个上限：一页六十张缩略图，正是图片清单绝不能把控件挤掉
  // 的那种页面。取条目预算的三分之一、下限为四，纯图片的页面也还能报出内容。
  const imageCap = Math.max(4, Math.floor(options.budget.maxItems / 3))
  const imageViews: ImageView[] = []
  /**
   * 会在页面文本里带标记的图片，按元素索引排。
   *
   * 它由 `Images:` 区块渲染的那个受上限约束的集合构建，所以标记和区块行说的永远是同一批
   * 图片；模型内联看到的任何索引都能查出来。
   */
  const imageIndexByElement = new Map<Element, number>()
  for (const image of images.slice(0, imageCap)) {
    const index = ids.indexOf(image.element)
    if (index === undefined) continue
    imageIndexByElement.set(image.element, index)
    imageViews.push({
      index,
      kind: image.kind,
      width: image.width,
      height: image.height,
      label: truncate(image.label, 80).text,
      near: image.near,
      src: shortSource(image.src),
      identity: imageIdentity(image.src, index),
      textDescribed: image.textDescribed,
      ...image.failed ? { unavailable: 'load-failed' } : {},
    })
  }

  const regionEl = options.region !== undefined && options.region !== ''
    ? document.querySelector(options.region)
    : null
  // 正文渲染时会在每张图的位置留一个标记。描述没法在这儿写——识别还没发生——所以标记由
  // background 拿到答案后再填。
  const mainSource = annotatedText(regionEl ?? mainRoot(document), imageIndexByElement)
  const mainBudget = Math.floor(options.budget.maxChars * 0.5)
  const main = truncate(mainSource, mainBudget)

  const lastItems = last === null ? new Map<number, InventoryItem>() : new Map(last.items.map((item) => [item.index, item]))
  const lastForms = last === null ? new Map<number, FormFieldView>() : new Map(last.forms.map((form) => [form.index, form]))
  const lastImages = last === null ? new Map<number, ImageView>() : new Map(last.images.map((image) => [image.index, image]))

  const changed = new Set<number>()
  const removedIds: number[] = []
  if (options.delta === true && last !== null) {
    if (last.main !== main.text || last.url !== location.href || last.title !== document.title) {
      changed.add(-1) // -1 = 正文/标题/URL 变了（渲染时再说明）
    }
    for (const item of items) {
      const before = lastItems.get(item.index)
      if (before === undefined || !sameItem(before, item)) changed.add(item.index)
    }
    for (const image of imageViews) {
      const before = lastImages.get(image.index)
      if (before === undefined || !sameImage(before, image)) changed.add(image.index)
    }
    const currentItemIds = new Set(items.map((item) => item.index))
    for (const index of lastItems.keys()) {
      if (!currentItemIds.has(index)) removedIds.push(index)
    }
    const currentImageIds = new Set(imageViews.map((image) => image.index))
    for (const index of lastImages.keys()) {
      if (!currentImageIds.has(index)) removedIds.push(index)
    }
    for (const form of forms) {
      const before = lastForms.get(form.index)
      if (before === undefined || !sameForm(before, form)) changed.add(form.index)
    }
  }

  return {
    version: (last?.version ?? 0) + 1,
    url: location.href,
    title: document.title,
    ready: document.readyState === 'complete' ? 'complete' : 'loading',
    main: main.text,
    items,
    forms,
    images: imageViews,
    changed: options.delta === true ? [...changed] : [],
    removed: options.delta === true ? removedIds : [],
    reindexed,
    truncated: {
      mainChars: main.truncated,
      itemsDropped: Math.max(0, elements.length - options.budget.maxItems),
      formsDropped: Math.max(0, formElements.length - options.budget.maxForms),
      imagesDropped: Math.max(0, images.length - imageCap),
    },
    budgetChars: options.budget.maxChars,
  }
}

function selectedText(select: HTMLSelectElement): string {
  return [...select.selectedOptions].map((option) => option.textContent ?? '').join(', ')
}

function sameItem(a: InventoryItem, b: InventoryItem): boolean {
  return a.role === b.role && a.name === b.name && a.href === b.href
    && a.disabled === b.disabled && a.checked === b.checked && a.inViewport === b.inViewport
}

function sameForm(a: FormFieldView, b: FormFieldView): boolean {
  return a.label === b.label && a.kind === b.kind && a.value === b.value && a.masked === b.masked
    && a.checked === b.checked && a.required === b.required
}

function sameImage(a: ImageView, b: ImageView): boolean {
  return a.kind === b.kind && a.src === b.src && a.label === b.label && a.near === b.near
    && a.width === b.width && a.height === b.height && a.unavailable === b.unavailable
}
/**
 * 把快照渲染成给模型看的文本。
 *
 * 图片以文字条目的形式出现，绝不出现像素：整个负载就是一块文本，而图片和按钮共用同一套稳定
 * 索引来寻址。
 *
 * @param view - 要渲染的快照。
 * @param delta - 是不是 delta 渲染（只含变化）。
 * @param maxChars - 可选渲染上限，用于紧凑的衍生响应。
 * @returns 文本负载。
 */
/** 渲染结果的总预算：标题、URL、包装行这些主文/清单之外的部分也算在里面。 */
function capRendered(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text
  return `${text.slice(0, budgetChars)}…(truncated to the snapshot character budget)`
}

function renderItem(item: InventoryItem): string {
  const state = [
    item.disabled === true ? 'disabled' : undefined,
    item.checked === undefined ? undefined : item.checked ? 'checked' : 'unchecked',
    item.inViewport ? undefined : 'outside viewport',
  ].filter((value) => value !== undefined).join('/')
  const stateText = state === '' ? '' : ` [${state}]`
  const hrefText = item.href !== undefined ? ` → ${item.href}` : ''
  return `  [${item.index}] ${item.role} "${item.name}"${stateText}${hrefText}`
}

function renderForm(form: FormFieldView, includeIdentity: boolean): string {
  const identity = includeIdentity ? `${form.label} (${form.kind}) ` : ''
  const state = form.checked === undefined
    ? `value="${form.masked ? '••••' : form.value}"`
    : `checked=${String(form.checked)}`
  return `  [${form.index}] ${identity}${state}${form.required === true ? ' required' : ''}`
}

/**
 * 页面有图片时，把标记的含义解释一遍。
 *
 * 正文里带着模型必须会读的标记，而没人解释的记法比没有还强不了多少：这些状态说明描述是已有、
 * 即将有、从没请求过，还是拿不到。一次快照只占一行，不是每张图一行；它还会点出能补上描述的
 * 工具——模型由此知道这套记法能动，不是摆设。
 */
function appendImageLegend(lines: string[], view: SnapshotView): void {
  if (view.images.length === 0) return
  lines.push('\n(⟦iN img:state⟧ marks image [N]. state is its description, "pending", "not-requested", or "unavailable:<reason>"; call browser_describe_image with the index to get one.)')
}

function appendTruncationNotes(lines: string[], view: SnapshotView): void {
  const notes: string[] = []
  if (view.truncated.mainChars > 0) notes.push(`Main content truncated by ${view.truncated.mainChars} characters`)
  if (view.truncated.itemsDropped > 0) notes.push(`${view.truncated.itemsDropped} additional elements omitted`)
  if (view.truncated.formsDropped > 0) notes.push(`${view.truncated.formsDropped} additional form fields omitted`)
  if (view.truncated.imagesDropped > 0) notes.push(`${view.truncated.imagesDropped} additional images omitted`)
  if (notes.length > 0) lines.push(`\n(${notes.join('; ')}. Use browser_get_text or specify region for more content.)`)
}

/**
 * 图片行上的简短地址。
 *
 * `data:` URL 本身就是图片，整段渲染出来只会把整个字符预算砸在 base64 上，而它告诉模型的东西
 * 并不比媒体类型多。其余的地址都沿用链接那套 path-or-host 形式。
 *
 * @param src - 图片的绝对地址。
 * @returns 这个地址在文本里该长什么样。
 */
function shortSource(src: string): string {
  if (src === '') return ''
  if (!src.startsWith('data:')) return hrefHeadline(src)
  const mediaType = src.slice(5).split(';')[0] ?? ''
  return `${mediaType === '' ? 'data' : mediaType} (inline)`
}

/**
 * 把一张图片写成一行文本。
 *
 * `text-described` 是给模型的信号：DOM 文本已经回答了这张图是什么，不用走识别就能读。地址
 * 用路径而不是完整 URL，道理和链接那儿一样：源在快照头部已经给了，每行再抄一遍只烧字符预算，
 * 不多给一点信息。
 *
 * 这一行以标记收尾，这样标注正文的同一趟填充也能报出这张图的状态。正文流内的图片，两边是
 * 冗余；正文流外的图片则非它不可，因为别处没有它们的位置。
 */
function renderImage(image: ImageView): string {
  const size = image.width > 0 && image.height > 0 ? ` ${image.width}x${image.height}` : ''
  const label = image.label === '' ? '' : ` "${image.label}"`
  const near = image.near === '' ? '' : ` near="${image.near}"`
  const described = image.textDescribed ? ' text-described' : ''
  const unavailable = image.unavailable === undefined ? '' : ` [${image.unavailable}]`
  const src = image.src === '' ? '' : ` → ${image.src}`
  return `  [${image.index}] ${image.kind}${size}${label}${near}${described}${unavailable}${src} ${imageMarker(image.index)}`
}

export function renderSnapshot(view: SnapshotView, delta: boolean, maxChars: number = view.budgetChars): string {
  const lines: string[] = []
  if (delta) {
    lines.push(`Page change v${view.version} (${view.url})`)
    const elementChanges = view.changed.filter((id) => id !== -1)
    const changedIds = new Set(elementChanges)
    const changedItems = view.items.filter((item) => changedIds.has(item.index))
    const changedForms = view.forms.filter((form) => changedIds.has(form.index))
    const changedImages = view.images.filter((image) => changedIds.has(image.index))

    lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
    if (view.changed.includes(-1)) {
      lines.push(`Title: ${view.title || '(untitled)'}`)
      if (view.main.length > 0) {
        lines.push('')
        lines.push('Changed main content:')
        lines.push(view.main)
      }
    }
    if (changedItems.length > 0) {
      lines.push('')
      lines.push('Changed interactive elements:')
      for (const item of changedItems) lines.push(renderItem(item))
    }
    if (changedForms.length > 0) {
      lines.push('')
      lines.push('Changed form fields:')
      const renderedItems = new Set(changedItems.map((item) => item.index))
      for (const form of changedForms) lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
    if (changedImages.length > 0) {
      lines.push('')
      lines.push('Changed images:')
      for (const image of changedImages) lines.push(renderImage(image))
    }
    if (view.removed.length > 0) lines.push(`Removed elements: ${view.removed.join(', ')}`)
    if (view.changed.length === 0 && view.removed.length === 0) lines.push('(No visible changes.)')
    appendImageLegend(lines, view)
    appendTruncationNotes(lines, view)
    return capRendered(lines.join('\n'), maxChars)
  }
  lines.push(`Title: ${view.title || '(untitled)'}`)
  lines.push(`URL: ${view.url}`)
  lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
  if (view.main.length > 0) {
    lines.push('')
    lines.push('Main content:')
    lines.push(view.main)
  }
  if (view.items.length > 0) {
    lines.push('')
    lines.push('Interactive elements:')
    for (const item of view.items) lines.push(renderItem(item))
  }
  if (view.forms.length > 0) {
    lines.push('')
    lines.push('Form fields:')
    const renderedItems = new Set(view.items.map((item) => item.index))
    for (const form of view.forms) {
      lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
  }
  if (view.images.length > 0) {
    lines.push('')
    lines.push('Images:')
    for (const image of view.images) lines.push(renderImage(image))
  }
  appendImageLegend(lines, view)
  appendTruncationNotes(lines, view)
  return capRendered(lines.join('\n'), maxChars)
}
