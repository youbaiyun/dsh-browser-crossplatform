// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectImages } from '../src/content/images.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

const BUDGET: SnapshotBudget = { maxItems: 9, maxForms: 5, maxChars: 6_000 }

/** 把 harness 的矩形（200x40）换成指定尺寸。 */
function stubRect(width: number, height: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('collectImages', () => {
  it('reports an image with its alt text and marks it text-described', () => {
    document.body.innerHTML = '<img src="/chart.png" alt="季度营收">'
    const [image] = collectImages(document)
    expect(image.kind).toBe('img')
    expect(image.label).toBe('季度营收')
    expect(image.textDescribed).toBe(true)
    expect(image.src).toBe('http://localhost:3000/chart.png')
  })

  it('reports an image with no text alternative as a recognition candidate', () => {
    document.body.innerHTML = '<img src="/photo.jpg">'
    const [image] = collectImages(document)
    expect(image.label).toBe('')
    expect(image.textDescribed).toBe(false)
  })

  it('skips images too small to be content', () => {
    document.body.innerHTML = '<img src="/spacer.gif" alt="x">'
    stubRect(16, 16)
    expect(collectImages(document)).toEqual([])
  })

  it('takes the caption as context and as a text description', () => {
    document.body.innerHTML = '<figure><img src="/a.png"><figcaption>图 1：营收趋势</figcaption></figure>'
    const [image] = collectImages(document)
    expect(image.near).toBe('图 1：营收趋势')
    expect(image.textDescribed).toBe(true)
  })

  it('reads nearby text when there is no caption', () => {
    document.body.innerHTML = '<div>商品主图 <img src="/a.png"></div>'
    const [image] = collectImages(document)
    expect(image.near).toContain('商品主图')
  })

  it('records the nearest heading above the image, not a later one', () => {
    // 「30%」在每个标题下的含义都不一样，所以 section 是页面上
    // 最省事的消歧依据。
    document.body.innerHTML = `
      <h1>年度报告</h1>
      <section><h2>本季度营收</h2><img src="/a.png"></section>
      <section><h2>退款率</h2></section>
    `
    const [image] = collectImages(document)
    expect(image.heading).toBe('本季度营收')
  })

  it('leaves the heading empty when the image precedes every heading', () => {
    document.body.innerHTML = '<img src="/a.png"><h2>后面的标题</h2>'
    const [image] = collectImages(document)
    expect(image.heading).toBe('')
  })

  it('skips display:none images', () => {
    document.body.innerHTML = '<img src="/hidden.png" alt="x" style="display:none">'
    expect(collectImages(document)).toEqual([])
  })

  it('treats an inline svg without text as an image and one with text as described', () => {
    document.body.innerHTML = `
      <svg width="100" height="60"><circle r="10" /></svg>
      <svg width="100" height="60"><text>已售出</text></svg>
    `
    const images = collectImages(document)
    expect(images).toHaveLength(2)
    expect(images[0].kind).toBe('svg')
    expect(images[0].textDescribed).toBe(false)
    expect(images[1].textDescribed).toBe(true)
  })

  it('reports a video poster', () => {
    document.body.innerHTML = '<video poster="/frame.png"></video>'
    const [image] = collectImages(document)
    expect(image.kind).toBe('poster')
    expect(image.src).toBe('http://localhost:3000/frame.png')
  })

  it('reports a css background image', () => {
    document.body.innerHTML = '<div id="hero"></div>'
    document.getElementById('hero')!.setAttribute('style', 'background-image: url("/hero.png")')
    const [image] = collectImages(document)
    expect(image.kind).toBe('background')
    expect(image.src).toBe('http://localhost:3000/hero.png')
    expect(image.textDescribed).toBe(false)
  })
})

describe('images that failed to load', () => {
  /** 让一张图片看起来像加载完成却失败了，就像浏览器报的那样。 */
  function markFailed(image: Element): void {
    Object.defineProperty(image, 'complete', { configurable: true, value: true })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 0 })
  }

  it('lists a failed image that has a text alternative, despite its collapsed box', () => {
    // 破图会缩成破图图标那么大，所以尺寸下限会
    // 把作者点名要的图片藏起来。
    document.body.innerHTML = '<img src="/missing.png" alt="营收趋势图">'
    markFailed(document.querySelector('img')!)
    stubRect(48, 21)
    const [image] = collectImages(document)
    expect(image.failed).toBe(true)
    expect(image.label).toBe('营收趋势图')
  })

  it('leaves a failed image with no text alternative out', () => {
    // 一个光秃秃的破图框什么也描述不了，只会添噪声。
    document.body.innerHTML = '<img src="/missing.png">'
    markFailed(document.querySelector('img')!)
    stubRect(48, 21)
    expect(collectImages(document)).toEqual([])
  })

  it('never mistakes a still-loading image for a failed one', () => {
    // jsdom 永远不会让加载完成，而这正是这里要守住的状态：
    // `complete` 是 false，所以不会有任何东西被报成失败。
    document.body.innerHTML = '<img src="/a.png" alt="图">'
    stubRect(48, 21)
    expect(collectImages(document)).toEqual([])
  })

  it('says so in the snapshot, and carries the reason for the marker', () => {
    document.body.innerHTML = '<img id="x" src="/missing.png" alt="营收趋势图">'
    markFailed(document.getElementById('x')!)
    stubRect(48, 21)
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    expect(renderSnapshot(view, false)).toContain('[load-failed]')
    // 后台读它来填标记，因为失败的图片
    // 永远不会被请求，也就永远不会进缓存。
    expect(view.images[0]?.unavailable).toBe('load-failed')
  })
})

describe('image inventory in the snapshot', () => {
  it('renders a data URL as its media type instead of the whole image', () => {
    // 内联图片的地址就是图片本身。把整张图渲染出来会把
    // 字符预算花在 base64 上，而它除了媒体类型说不出任何东西。
    document.body.innerHTML = `<img src="data:image/png;base64,${'A'.repeat(400)}" alt="内联图">`
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET }, null), false)
    expect(text).toContain('→ image/png (inline)')
    expect(text).not.toContain('AAAA')
  })

  it('numbers images in the same registry as controls, so an index is clickable', () => {
    document.body.innerHTML = `
      <button>提交</button>
      <img id="chart" src="/chart.png">
    `
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)

    expect(view.images).toHaveLength(1)
    const [image] = view.images
    // 共享注册表的意义就在于：点击路径把一个图片索引
    // 解析成真实元素，全程不用任何坐标运算。
    expect(ids.elementByIndex(image.index)).toBe(document.getElementById('chart'))
    // 图片不是控件，所以绝不能出现在可交互元素列表里。
    expect(view.items.some((item) => item.name === 'chart')).toBe(false)
  })

  it('renders an Images section with kind, size, label and description state', () => {
    document.body.innerHTML = `
      <img src="/chart.png" alt="季度营收">
      <img src="/photo.jpg">
    `
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const text = renderSnapshot(view, false)

    expect(text).toContain('Images:')
    const chart = view.images.find((image) => image.src.endsWith('/chart.png'))!
    const photo = view.images.find((image) => image.src.endsWith('/photo.jpg'))!
    expect(text).toContain(`[${chart.index}] img 200x40 "季度营收" text-described → /chart.png`)
    expect(text).toContain(`[${photo.index}] img 200x40 → /photo.jpg`)
    // 已经描述过的图片绝不能被标成需要识别。
    expect(text).not.toContain(`[${photo.index}] img 200x40 text-described`)
  })

  it('caps images by the shared element budget and reports the drops', () => {
    document.body.innerHTML = Array.from({ length: 20 }, (_, i) => `<img src="/i${i}.png" alt="图${i}">`).join('')
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: { ...BUDGET, maxItems: 30 } }, null)
    expect(view.images).toHaveLength(10)
    expect(view.truncated.imagesDropped).toBe(10)
    expect(renderSnapshot(view, false)).toContain('10 additional images omitted')
  })

  it('reports an image change in delta mode', () => {
    document.body.innerHTML = '<img src="/a.png" alt="旧说明">'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { delta: true, budget: BUDGET }, null)
    document.querySelector('img')!.setAttribute('alt', '新说明')

    const second = buildSnapshot(ids, { delta: true, budget: BUDGET }, first)
    const text = renderSnapshot(second, true)
    expect(text).toContain('Changed images:')
    expect(text).toContain('新说明')
  })
})
