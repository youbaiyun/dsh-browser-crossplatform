// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshot, renderSnapshot } from '../src/content/snapshot.ts'
import { ElementIds } from '../src/content/ids.ts'

/**
 * BUG 报告 P2-9：CSS 背景图（`background-image: url(...)`）应当和 `<img>`、内联 SVG
 * 一样出现在快照的 Images 段。
 */

const BUDGET = { maxItems: 30, maxForms: 10, maxChars: 8_000 }

afterEach(() => {
  document.body.innerHTML = ''
})

describe('background images', () => {
  it('lists a css background image next to img and inline svg', () => {
    document.body.innerHTML = `
      <h1>靶页</h1>
      <main>
        <img alt="照片" src="https://example.com/a.png">
        <svg width="40" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40"/></svg>
        <div id="bg" style="width:40px;height:40px;background-image:url(https://example.com/bg.svg)"></div>
      </main>
    `
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET }, null), false)

    expect(text).toContain('Images:')
    expect(text).toContain('bg.svg')
    expect(text).toContain('background')
  })

  it('skips gradients', () => {
    document.body.innerHTML = `
      <div id="gradient" style="width:40px;height:40px;background-image:linear-gradient(red, blue)"></div>
    `
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET }, null), false)

    expect(text).not.toContain('linear-gradient')
  })
})
