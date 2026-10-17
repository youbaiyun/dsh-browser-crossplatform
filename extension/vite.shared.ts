import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'

/**
 * 扩展三个目标共用的构建管线（background 的 ES service worker、iife 的
 * content script、control-strip 弹窗页面）。每个目标有自己的配置文件；
 * scripts/build.mjs 把它们依次跑进同一个 dist/。
 */

/**
 * 构建目标：`chrome`（默认）或 `firefox`（设置 EXT_TARGET=firefox，
 * 或给 scripts/build.mjs 传 --firefox）。每个目标有自己的 manifest 和输出目录，
 * 所以两份构建可以共存。
 */
export const browserTarget = process.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome'
export const targetManifest = browserTarget === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'

const storeTarget = process.env.EXT_STORE === '1'
export const outDir = resolve(
  import.meta.dirname,
  storeTarget
    ? (browserTarget === 'firefox' ? 'dist-firefox-store' : 'dist-store')
    : (browserTarget === 'firefox' ? 'dist-firefox' : 'dist'),
)

/**
 * 商店会接受的 manifest。
 *
 * 仓库里的 manifest 带着一个 `key`，它钉住扩展 id——bridge 那条免 token 的
 * loopback 路径就绑定在这个确切的 id 上，所以开发构建需要它。商店则直接拒绝它：
 * "清单文件中不得包含 key 字段"（这是 Chrome Web Store 自己的措辞）。商店会另行
 * 分配 id，所以这里把 `key` 去掉，别的什么都不动。
 */
function manifestForOutput(): string {
  const text = readFileSync(resolve(import.meta.dirname, targetManifest), 'utf8')
  if (!storeTarget) return text
  const parsed = JSON.parse(text) as Record<string, unknown>
  delete parsed.key
  return `${JSON.stringify(parsed, null, 2)}\n`
}

/** 把 manifest、语言目录、图标和许可证复制进目标的 outDir。 */
export const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, 'manifest.json'), manifestForOutput(), 'utf8')
    cpSync(resolve(import.meta.dirname, '_locales'), resolve(outDir, '_locales'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'assets'), resolve(outDir, 'assets'), { recursive: true })
    // 许可证随构建一起走，而不是只留在仓库里：一个打包好的扩展就是本软件的
    // 分发，而 MIT 要求随它的副本一起附上版权声明和许可文本。
    // 仓库根目录在本包的上一级。
    copyFileSync(resolve(import.meta.dirname, '..', 'LICENSE'), resolve(outDir, 'LICENSE'))
  },
}

/** 每个目标共用的插件：tsconfig paths（直接消费插件 protocol 源码，
 * 类似 SDK 的源码消费方式）加上 manifest 复制。 */
export const sharedPlugins = [tsconfigPaths({ projects: ['./tsconfig.json'] }), copyManifest]

/** 非面板目标共用的构建选项。 */
export function targetBuild(entry: string, format: 'es' | 'iife', entryFileNames: string, emptyOutDir: boolean) {
  return defineConfig({
    define: {
      'import.meta.env.EXT_TARGET': JSON.stringify(browserTarget),
    },
    build: {
      outDir,
      emptyOutDir,
      rollupOptions: {
        input: resolve(import.meta.dirname, entry),
        output: { format, entryFileNames },
      },
    },
    plugins: sharedPlugins,
  })
}
