// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * BUG 报告 P1-4：在填好的输入框上按 Enter，表单不会提交。
 *
 * 旧实现只往页面里丢了一个合成 `submit` 事件——那不会跑浏览器的表单提交算法，
 * 于是校验、`submit` 监听里的默认行为、请求构造全都跳过。真实回车走的是
 * `requestSubmit()`。这里把「页面自己做主」和「扩展替浏览器做主」两种情况都钉住。
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

function context(): { ids: ElementIds; budget: typeof BUDGET } {
  return { ids: { elementByIndex: vi.fn() } as unknown as ElementIds, budget: BUDGET }
}

/** 一个带提交监听（并取消导航）的表单，返回它收到的提交次数。 */
function formWithInput(input: HTMLInputElement): { form: HTMLFormElement; submitted: ReturnType<typeof vi.fn> } {
  const submitted = vi.fn()
  const form = document.createElement('form')
  form.append(input)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submitted()
  })
  document.body.append(form)
  return { form, submitted }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('browser_press Enter in a form', () => {
  it('submits the form of the focused input through the browser algorithm', async () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = 'hello'
    const { submitted } = formWithInput(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    await runAction('browser_press', { key: 'Enter' }, context())

    expect(submitted).toHaveBeenCalledOnce()
  })

  it('does not submit a second time when the page handled the keydown itself', async () => {
    // 搜索框常见的做法：拦下 Enter，自己发请求，再 preventDefault。
    // 扩展这时再 requestSubmit 一次就是重复提交。
    const input = document.createElement('input')
    input.type = 'search'
    const { submitted } = formWithInput(input)
    const pageSubmit = vi.fn()
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      pageSubmit()
    })
    input.focus()

    await runAction('browser_press', { key: 'Enter' }, context())

    expect(pageSubmit).toHaveBeenCalledOnce()
    expect(submitted).not.toHaveBeenCalled()
  })

  it('leaves textarea line breaks alone instead of submitting the form', async () => {
    const textarea = document.createElement('textarea')
    const { submitted } = formWithInput(textarea as unknown as HTMLInputElement)
    textarea.focus()

    await runAction('browser_press', { key: 'Enter' }, context())

    expect(submitted).not.toHaveBeenCalled()
  })

  it('clicks a focused submit button rather than submitting around it', async () => {
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    form.append(button)
    const submitted = vi.fn()
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitted()
    })
    document.body.append(form)
    button.focus()

    await runAction('browser_press', { key: 'Enter' }, context())

    expect(submitted).toHaveBeenCalledOnce()
  })

  it('dispatches the keydown and keyup the page can observe', async () => {
    const input = document.createElement('input')
    input.type = 'text'
    formWithInput(input)
    const seen: string[] = []
    input.addEventListener('keydown', (event) => { seen.push(`down:${event.key}`) })
    input.addEventListener('keyup', (event) => { seen.push(`up:${event.key}`) })
    input.focus()

    await runAction('browser_press', { key: 'Enter' }, context())

    expect(seen).toEqual(['down:Enter', 'up:Enter'])
  })
})
