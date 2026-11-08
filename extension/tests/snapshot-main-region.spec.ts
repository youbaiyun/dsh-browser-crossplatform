// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshot, renderSnapshot } from '../src/content/snapshot.ts'
import { ElementIds } from '../src/content/ids.ts'

/**
 * BUG 报告 P1-6：`<h1>` 和正文外的导语没有被快照收录；等导语变了，
 * delta 又说「No visible changes.」——因为正文比对只看 `<main>`。
 */

const BUDGET = { maxItems: 30, maxForms: 10, maxChars: 8_000 }

afterEach(() => {
  document.body.innerHTML = ''
})

describe('main content outside the main landmark', () => {
  it('renders the heading and lede that sit outside <main>', () => {
    document.body.innerHTML = `
      <h1>测试靶页 A</h1>
      <p id="intro">这是导语。</p>
      <main><p>这是正文。</p></main>
    `
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET }, null), false)

    expect(text).toContain('测试靶页 A')
    expect(text).toContain('这是导语。')
    expect(text).toContain('这是正文。')
  })

  it('reports a change to text outside <main> in delta mode', () => {
    document.body.innerHTML = `
      <h1>测试靶页 A</h1>
      <p id="intro">这是导语。</p>
      <main><p>这是正文。</p></main>
    `
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)

    document.getElementById('intro')!.textContent = '导语已经更新。'
    const second = buildSnapshot(ids, { budget: BUDGET, delta: true }, first)
    const text = renderSnapshot(second, true)

    expect(text).toContain('导语已经更新。')
    expect(text).not.toContain('(No visible changes.)')
  })

  it('does not repeat the main landmark text when it sits in a wrapper', () => {
    document.body.innerHTML = `
      <h1>标题</h1>
      <div class="wrap"><main><p>独占正文</p></main></div>
    `
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET }, null), false)

    expect(text.match(/独占正文/gu)).toHaveLength(1)
    expect(text).toContain('标题')
  })
})
