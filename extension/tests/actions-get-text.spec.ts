// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isInViewport } from '../src/content/extract.ts'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('isInViewport in a minimized window', () => {
  it('does not claim every element is outside a zero-sized viewport', () => {
    document.body.innerHTML = '<p>正文</p>'
    const paragraph = document.querySelector('p')!
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 900,
      left: 0,
      right: 100,
      bottom: 920,
      width: 100,
      height: 20,
      x: 0,
      y: 900,
      toJSON: () => ({}),
    } as DOMRect)
    // P2-11：最小化时浏览器报告 0×0 视口；按公式这个段落会被标成视口外。
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(0)
    const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(0)
    expect(isInViewport(paragraph)).toBe(true)
    width.mockReturnValue(1200)
    height.mockReturnValue(800)
    expect(isInViewport(paragraph)).toBe(false)
  })
})

describe('browser_get_text with a selector', () => {
  it('fails like browser_click instead of reporting a successful empty read', async () => {
    document.body.innerHTML = '<main>正文</main>'
    const ids = new ElementIds()
    // P2-12：选择器没命中时要报错，不能回一句看起来像页面内容的成功文本。
    await expect(runAction('browser_get_text', { selector: '#missing' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ name: 'ActionError', code: 'action-failed' })
    const result = await runAction('browser_get_text', { selector: 'main' }, { ids, budget: BUDGET })
    expect(result.text).toContain('正文')
  })
})
