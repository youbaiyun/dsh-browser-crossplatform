/** 扩展 UI 支持的语言。 */
export type UiLocale = 'en' | 'zh'

/**
 * 中文区域的浏览器就用中文；其他区域一律刻意退回英文，
 * 这样没翻译的第三语言永远不会漏进 UI。
 */
export function localeFromLanguage(language: string | null | undefined): UiLocale {
  const normalized = language?.trim().toLowerCase() ?? ''
  return normalized === 'zh' || normalized.startsWith('zh-') ? 'zh' : 'en'
}

/** 读浏览器的首选语言，取不到就退回扩展 UI 的区域设置。 */
export function getUiLocale(): UiLocale {
  let language: string | undefined
  if (typeof navigator !== 'undefined') {
    const preferred = navigator.languages?.find((candidate) => candidate.trim() !== '') ?? navigator.language
    language = preferred.trim() === '' ? undefined : preferred
  }
  if (language === undefined && typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage !== undefined) {
    try {
      language = chrome.i18n.getUILanguage()
    } catch {
      // 某些 mock、或者已经不新鲜的扩展上下文，会暴露一个用不了的 API。
    }
  }
  return localeFromLanguage(language)
}
