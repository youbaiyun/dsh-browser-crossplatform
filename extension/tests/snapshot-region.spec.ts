// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshot, renderSnapshot } from '../src/content/snapshot.ts'
import { ElementIds } from '../src/content/ids.ts'

/**
 * BUG 报告 P2-8：`region` 以前只裁正文，交互清单仍然列出整页。
 */

const BUDGET = { maxItems: 30, maxForms: 10, maxChars: 8_000 }

afterEach(() => {
  document.body.innerHTML = ''
})

describe('region snapshot', () => {
  it('scopes the interactive inventory to the region', () => {
    document.body.innerHTML = `
      <button id="outside">区域外按钮</button>
      <form id="f"><input name="q"><button id="inside">区域内按钮</button></form>
    `
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET, region: '#f' }, null), false)

    expect(text).toContain('区域内按钮')
    expect(text).not.toContain('区域外按钮')
  })

  it('keeps the whole page inventory when no region is given', () => {
    document.body.innerHTML = `
      <button id="outside">区域外按钮</button>
      <form id="f"><button id="inside">区域内按钮</button></form>
    `
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET }, null), false)

    expect(text).toContain('区域内按钮')
    expect(text).toContain('区域外按钮')
  })
})
