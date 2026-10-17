// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WAIT_MAX_BUDGET_MS, runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * 这两项能力的 *schema* 早就在了，实现却晚得多：
 * 通过 `browser_type` 填 `<select>` 或复选框/单选按钮，以及等一个
 * `browser_wait` 条件。
 *
 * 两者都在 `packages/bridge/src/tools.ts` 里向模型声明过，所以照着描述
 * 行事的模型就会去用它们。在这些测试出现之前，select
 * 分支会抛 `is not editable`，复选框分支会往 `.value` 里写，而
 * wait 条件被悄悄忽略——对从没发生过的事情
 * 报告成功。
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
}

function append<T extends HTMLElement>(element: T): T {
  document.body.append(element)
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('browser_type on a <select>', () => {
  function select(): HTMLSelectElement {
    const el = document.createElement('select')
    for (const [value, label] of [['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      el.append(option)
    }
    return append(el)
  }

  it('selects by option value', async () => {
    const el = select()
    const result = await runAction('browser_type', { index: 1, text: 'b' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.value).toBe('b')
    expect(result.text).toContain('Beta')
  })

  it('selects by visible label when no value matches', async () => {
    const el = select()
    await runAction('browser_type', { index: 1, text: 'Gamma' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.value).toBe('c')
  })

  it('selects by 1-based position as a last resort', async () => {
    const el = select()
    await runAction('browser_type', { index: 1, text: '3' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.value).toBe('c')
  })

  it('fires the change event the page listens for', async () => {
    const el = select()
    const seen: string[] = []
    el.addEventListener('change', () => seen.push('change'))
    await runAction('browser_type', { index: 1, text: 'a' }, { ids: idsFor(el), budget: BUDGET })
    expect(seen).toContain('change')
  })

  it('lists the available options when nothing matches, instead of a dead end', async () => {
    const el = select()
    // 有标签这份列表才可用：只有 `1. a` 什么也说明不了。
    await expect(runAction('browser_type', { index: 1, text: 'nope' }, { ids: idsFor(el), budget: BUDGET }))
      .rejects.toThrow(/no option matching "nope".*Alpha.*Gamma/su)
  })
})

describe('browser_type on a checkbox or radio', () => {
  it('checks a checkbox from "true" and reports the state', async () => {
    const el = append(document.createElement('input'))
    el.type = 'checkbox'
    const result = await runAction('browser_type', { index: 2, text: 'true' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.checked).toBe(true)
    expect(result.text).toContain('Checked')
  })

  it('unchecks from "false" without touching the value property', async () => {
    const el = append(document.createElement('input'))
    el.type = 'checkbox'
    el.checked = true
    await runAction('browser_type', { index: 2, text: 'false' }, { ids: idsFor(el), budget: BUDGET })
    expect(el.checked).toBe(false)
  })

  it('moves the selection within a radio group', async () => {
    const first = append(document.createElement('input'))
    first.type = 'radio'
    first.name = 'pick'
    first.checked = true
    const second = append(document.createElement('input'))
    second.type = 'radio'
    second.name = 'pick'

    await runAction('browser_type', { index: 2, text: 'true' }, { ids: idsFor(second), budget: BUDGET })
    expect(second.checked).toBe(true)
    expect(first.checked).toBe(false)
  })

  it('rejects a value that is not a boolean, and says what to pass', async () => {
    const el = append(document.createElement('input'))
    el.type = 'checkbox'
    await expect(runAction('browser_type', { index: 2, text: 'maybe' }, { ids: idsFor(el), budget: BUDGET }))
      .rejects.toThrow(/pass true or false/u)
  })
})

describe('browser_wait conditions', () => {
  const context = (): { ids: ElementIds; budget: typeof BUDGET } => ({ ids: idsFor(document.body), budget: BUDGET })

  it('returns as soon as the selector matches', async () => {
    const target = append(document.createElement('div'))
    target.id = 'ready'
    const result = await runAction('browser_wait', { selector: '#ready' }, context())
    expect(result.text).toContain('#ready')
  })

  it('waits for a selector that appears later', async () => {
    setTimeout(() => {
      const late = document.createElement('span')
      late.className = 'late'
      document.body.append(late)
    }, 250)
    const result = await runAction('browser_wait', { selector: '.late' }, context())
    expect(result.text).toContain('.late')
  })

  it('fails with the timeout code when the selector never appears', async () => {
    // 条件的全部意义就在这里：绝不能把「它一直没出现」报
    // 成成功，否则模型会永远守在一个不会变化的页面上。
    await expect(runAction('browser_wait', { selector: '#never', ms: 300 }, context()))
      .rejects.toMatchObject({ code: 'timeout' })
  })

  it('waits for text and fails when it never appears', async () => {
    const target = append(document.createElement('p'))
    target.textContent = 'loaded'
    const result = await runAction('browser_wait', { text: 'loaded' }, context())
    expect(result.text).toContain('loaded')

    await expect(runAction('browser_wait', { text: 'absent', ms: 300 }, context()))
      .rejects.toMatchObject({ code: 'timeout' })
  })

  it('matches text after the same whitespace collapse the page text gets', async () => {
    // `pageText` 会把每一段连续空白折成一个空格，所以带换行或
    // 双空格的 needle 不做同样处理就永远匹配不上。
    const target = append(document.createElement('p'))
    target.textContent = 'Order confirmed'
    const result = await runAction('browser_wait', { text: 'Order\n  confirmed', ms: 2_000 }, context())
    expect(result.text).toContain('Order confirmed')
  })

  it('bounds the caller-supplied budget, so a wait cannot hold the slot forever', () => {
    // 断言那个常量，不靠等待：`1e999` 这样的 `ms` 经 JSON 解析会得到
    // Infinity，钳制就是为了不让它变成一个永不结束的
    // 轮询。真跑一遍就意味着一个 60 秒的测试。
    expect(WAIT_MAX_BUDGET_MS).toBe(60_000)
    expect(WAIT_MAX_BUDGET_MS).toBeLessThan(90_000)
  })

  it('keeps working as a plain delay when no condition is given', async () => {
    const started = Date.now()
    const result = await runAction('browser_wait', { ms: 200 }, context())
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(result.text).toContain('stable')
  })
})
