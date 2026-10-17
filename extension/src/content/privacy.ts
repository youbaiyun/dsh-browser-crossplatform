/**
 * 页面快照的隐私边界：敏感表单字段绝不回显。
 *
 * 浏览器页面这条通道用的就是文本快照，所以表单字段的值
 * 只有快照这一种方式能到达模型。密码/信用卡字段会被掩成固定占位符；
 * 真实值绝不离开页面。
 *
 * @module
 */

/** 这些 name/id/aria-label 片段会把字段标成敏感。 */
const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit/i,
  /card/i,
  /cvv/i,
  /cvc/i,
  /secret/i,
  /pwd/i,
]

/**
 * 判断某个表单字段是不是绝不能回显给模型。
 * @param el - 表单元素（input/select/textarea）。
 * @returns 密码输入框、信用卡 autocomplete 字段，以及 id/name/aria-label
 *   命中敏感片段的字段都返回 true。
 */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return true
    const autocomplete = String(el.autocomplete)
    if (autocomplete === 'credit-card' || autocomplete.startsWith('cc-')) return true
  }
  const name = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? el.name
    : ''
  const haystack = [el.id, name, el.getAttribute('aria-label')].filter(Boolean).join(' ')
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(haystack))
}

/**
 * 给快照掩掉敏感值。非空值都会变成同一个固定占位符，
 * 模型因此只知道这儿有个值，不知道内容是什么。
 * @param value - 字段当前的值。
 * @returns 掩码后的表示。
 */
export function maskValue(value: string): string {
  return value.length === 0 ? '' : '••••'
}
