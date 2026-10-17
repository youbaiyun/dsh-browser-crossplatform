import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/**
 * 把 Vite 的资源 URL 改写成相对于 `control/index.html` 自己所在目录的形式。
 *
 * Vite 默认用根绝对 URL，而它的 `base` 选项表达不了“相对于这个嵌套 html 文件”：
 * `base: './'` 对这个入口会产出 `../control/...`，那会逃到 `dist/` 并 404。
 * 这个页面在 `chrome-extension://` 和 `moz-extension://` 下都按
 * `control/index.html` 加载，所以 `./assets/...` 是两种情形下都能解析的唯一形式。
 */
const relativeControlAssets: Plugin = {
  name: 'dsh-relative-control-assets',
  apply: 'build',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler(html: string): string {
      return html.replaceAll('="/control/assets/', '="./assets/').replaceAll('="control/assets/', '="./assets/')
    },
  },
}

/** Control strip：无依赖的原生 DOM 页面（html 入口）。 */
export default defineConfig({
  plugins: [...sharedPlugins, relativeControlAssets],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'control/index.html'),
      output: {
        entryFileNames: 'control/assets/[name].js',
        chunkFileNames: 'control/assets/[name]-[hash].js',
        assetFileNames: 'control/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
