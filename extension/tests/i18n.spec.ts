// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUiLocale, localeFromLanguage } from '../src/i18n.ts'
import type { OpenError } from '../control/command.ts'
import { controlCopy, describeOpenError } from '../control/strings.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser locale selection', () => {
  it('uses Chinese for every zh locale variant', () => {
    expect(localeFromLanguage('zh')).toBe('zh')
    expect(localeFromLanguage('zh-CN')).toBe('zh')
    expect(localeFromLanguage('zh-TW')).toBe('zh')
    expect(localeFromLanguage('ZH-hant-HK')).toBe('zh')
  })

  it('defaults every non-Chinese or missing locale to English', () => {
    expect(localeFromLanguage('en-US')).toBe('en')
    expect(localeFromLanguage('ja-JP')).toBe('en')
    expect(localeFromLanguage('fr')).toBe('en')
    expect(localeFromLanguage(undefined)).toBe('en')
  })

  it('uses the browser\'s first preferred language', () => {
    vi.stubGlobal('navigator', { languages: ['zh-Hant', 'en-US'], language: 'en-US' })
    expect(getUiLocale()).toBe('zh')

    vi.stubGlobal('navigator', { languages: ['de-DE', 'zh-CN'], language: 'de-DE' })
    expect(getUiLocale()).toBe('en')
  })
})

describe('open-directive errors are translated', () => {
  /**
   * 解析器可能报的每个 reason 各取一个。
   *
   * 解析器返回的是 reason，不是句子，所以一个没有对应文案的
   * reason 就是用户永远看不到的消息。面板里曾有九条消息
   * 硬编码成中文，英文用户就读到中文；这个测试
   * 就是用来在新增 reason 时让两份列表保持同步的。
   */
  const EVERY_REASON: OpenError[] = [
    { kind: 'directiveFormat', known: '@open', soft: true },
    { kind: 'unknownDirective', directive: 'opne', known: '@open' },
    { kind: 'missingUrl', directive: 'open' },
    { kind: 'firstArgumentNotUrl', directive: 'open', received: 'not a url' },
    { kind: 'notKeyValue', pair: '--fast' },
    { kind: 'paceInvalid', allowed: 'fast / normal / slow', received: 'quick' },
    { kind: 'pinInvalid', received: 'maybe' },
    { kind: 'unknownKey', key: 'verify' },
    { kind: 'unparsable' },
  ]

  it('words every reason in both languages, and differently', () => {
    for (const error of EVERY_REASON) {
      const zh = describeOpenError('zh', error)
      const en = describeOpenError('en', error)
      expect(zh, `${error.kind} (zh)`).toBeTruthy()
      expect(en, `${error.kind} (en)`).toBeTruthy()
      // 输出一样，就意味着有一种语言根本没写。
      expect(zh, `${error.kind} must differ by language`).not.toBe(en)
      // 绝不能把中文交给英文用户。
      expect(en, `${error.kind} (en) must not contain Chinese characters`).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('carries the values the user typed back into the message', () => {
    // 报错不重复给出错的值，用户就得去猜。
    expect(describeOpenError('en', { kind: 'unknownKey', key: 'verify' })).toContain('verify')
    expect(describeOpenError('en', { kind: 'paceInvalid', allowed: 'a / b', received: 'quick' })).toContain('quick')
    expect(describeOpenError('zh', { kind: 'unknownKey', key: 'verify' })).toContain('verify')
  })

  it('says nothing in Chinese to an English reader anywhere in the copy table', () => {
    // 把英文表通扫一遍，这样从中文表里粘过来的字符串
    // 无论落在哪里都会被抓住，不只是在正在编辑的那一组里。
    const english = controlCopy('en')
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        expect(value, `${path} must not be Chinese`).not.toMatch(/[\u4e00-\u9fff]/)
        return
      }
      if (typeof value === 'function') return
      if (value === null || typeof value !== 'object') return
      for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`)
    }
    walk(english, 'EN')
  })
})
