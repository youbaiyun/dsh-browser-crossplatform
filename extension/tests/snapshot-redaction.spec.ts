// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshot, redactSensitiveUrl, renderSnapshot } from '../src/content/snapshot.ts'
import type { SnapshotView } from '../src/content/snapshot.ts'
import { ElementIds } from '../src/content/ids.ts'

/**
 * BUG 报告 P1-5：`?user=alice&pwd=s3cret` 原样出现在快照的 URL 行里。
 *
 * 快照会被送进模型上下文，页面地址里的会话、令牌、签名、一次性验证码都跟着走。
 * 规则是只换值、保留参数名，模型仍然能看懂地址的结构。
 */

const BUDGET = { maxItems: 30, maxForms: 10, maxChars: 8_000 }

const EMPTY_BUDGET_ACCOUNTING = {
  mainChars: 0,
  itemsDropped: 0,
  formsDropped: 0,
  imagesDropped: 0,
}

function view(url: string, extra: Partial<SnapshotView> = {}): SnapshotView {
  return {
    version: 1,
    url,
    title: 'Sign in',
    ready: 'complete',
    main: '',
    items: [],
    forms: [],
    images: [],
    changed: [],
    removed: [],
    reindexed: false,
    truncated: EMPTY_BUDGET_ACCOUNTING,
    budgetChars: BUDGET.maxChars,
    ...extra,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('sensitive query parameter redaction', () => {
  it('masks password-like values but keeps the rest of the address readable', () => {
    const text = renderSnapshot(view('https://example.com/login?user=alice&pwd=s3cret&next=%2Fhome'), false)

    expect(text).toContain('URL: https://example.com/login?user=alice&pwd=***&next=%2Fhome')
    expect(text).not.toContain('s3cret')
  })

  it('covers tokens, signatures and one-time codes, and keeps the fragment', () => {
    const text = renderSnapshot(
      view('https://example.com/cb?access_token=abc.def&sig=deadbeef&otp=123456&view=list#done'),
      false,
    )

    expect(text).toContain('access_token=***')
    expect(text).toContain('sig=***')
    expect(text).toContain('otp=***')
    expect(text).toContain('view=list#done')
    expect(text).not.toContain('abc.def')
    expect(text).not.toContain('deadbeef')
    expect(text).not.toContain('123456')
  })

  it('leaves addresses without sensitive parameters exactly as they are', () => {
    const url = 'https://example.com/search?q=vitest&page=2'
    expect(redactSensitiveUrl(url)).toBe(url)
    expect(redactSensitiveUrl('/a/b.png')).toBe('/a/b.png')
    expect(redactSensitiveUrl('https://example.com/a#frag')).toBe('https://example.com/a#frag')
  })

  it('masks an encoded parameter name too', () => {
    expect(redactSensitiveUrl('/login?pa%73sword=hunter2')).toBe('/login?pa%73sword=***')
  })

  it('masks the same way in a delta header', () => {
    const text = renderSnapshot(view('https://example.com/a?session=abcdef'), true)

    expect(text).toContain('https://example.com/a?session=***')
    expect(text).not.toContain('abcdef')
  })

  it('masks links and image sources rendered from the live page', () => {
    document.body.innerHTML = `
      <a href="/report?api_key=SECRETKEY">下载</a>
      <img src="/chart.png?token=SECRETTOKEN" alt="图表">
    `
    const ids = new ElementIds()
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET }, null), false)

    expect(text).toContain('api_key=***')
    expect(text).toContain('token=***')
    expect(text).not.toContain('SECRETKEY')
    expect(text).not.toContain('SECRETTOKEN')
  })
})
