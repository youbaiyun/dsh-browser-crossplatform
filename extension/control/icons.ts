/**
 * 内联 SVG 图标集。
 *
 * 这套 UI 的规矩：界面图标一律是代码（SVG、`currentColor`，不用
 * sprite 图、不用图标字体、不联网），而鲸鱼标志一类的图片资源
 * 仍是原始 PNG 文件。下面每条 path 都是 24×24 的 Material 风格
 * 轮廓线，好让图标摆在 Segoe UI 文字旁边时位置正确。
 *
 * @module
 */

const ICONS = {
  send: '<path d="M3.4 20.4 20.85 12 3.4 3.6l.01 6.53L15 12 3.41 13.87z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  chevron: '<path d="M9.29 6.71a.996.996 0 0 0 0 1.41L13.17 12l-3.88 3.88a.996.996 0 1 0 1.41 1.41l4.59-4.59a.996.996 0 0 0 0-1.41L10.7 6.7a.996.996 0 0 0-1.41.01z"/>',
  check: '<path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
  close: '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
  alert: '<path d="M12 2 1 21h22zm1 16h-2v-2h2zm0-4h-2V9h2z"/>',
  info: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>',
  globe: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.95a15.6 15.6 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4.04A14 14 0 0 1 13.9 8h-3.8A14 14 0 0 1 12 4.04zM4.26 14a8 8 0 0 1 0-4h3.38a16.6 16.6 0 0 0 0 4zm.84 2h2.95a15.6 15.6 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm2.95-8H5.1a8 8 0 0 1 4.35-3.6A15.6 15.6 0 0 0 8.05 8zM12 19.96A14 14 0 0 1 10.1 16h3.8A14 14 0 0 1 12 19.96zM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4zm1.21 5.6a15.6 15.6 0 0 0 1.4-3.6h2.95a8 8 0 0 1-4.35 3.6zm1.81-5.6a16.6 16.6 0 0 0 0-4h3.38a8 8 0 0 1 0 4z"/>',
  shield: '<path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11z"/>',
  list: '<path d="M3 13h2v-2H3zm0 4h2v-2H3zm0-8h2V7H3zm4 4h14v-2H7zm0 4h14v-2H7zM7 7v2h14V7z"/>',
  refresh: '<path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/>',
  settings: '<path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  clock: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 11h-6v-2h4V6h2z"/>',
  ban: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.32L5.68 16.9A7.96 7.96 0 0 1 4 12zm8 8a7.96 7.96 0 0 1-4.9-1.68L18.32 7.1A8 8 0 0 1 12 20z"/>',
  keyboard: '<path d="M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm-9 3h2v2h-2zm0 3h2v2h-2zM8 8h2v2H8zm0 3h2v2H8zm-3-3h2v2H5zm0 3h2v2H5zm2 4v-1h10v1zm11-4h-2v-2h2zm0-3h-2V8h2z"/>',
  sparkle: '<path d="M12 2 9.9 8.6 3 11l6.9 2.4L12 20l2.1-6.6L21 11l-6.9-2.4z"/>',
  link: '<path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 0-10z"/>',
} as const

export type IconName = keyof typeof ICONS

/**
 * 构建一个图标元素。
 *
 * 图标是装饰性的：它们带 `aria-hidden`，并沿用周围颜色，
 * 这样紧挨着它们的 label 才是无障碍名称。
 */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.innerHTML = ICONS[name]
  return svg
}

/** 同样的标记以字符串形式给出，供少数拼接 HTML 片段的地方使用。 */
export function iconMarkup(name: IconName, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`
}

/** 时间线某一行上的状态标记。 */
export function markerIcon(state: string): IconName {
  switch (state) {
    case 'done': return 'check'
    case 'failed': return 'close'
    case 'denied': return 'ban'
    case 'cancelled': return 'close'
    case 'running': return 'play'
    default: return 'clock'
  }
}
