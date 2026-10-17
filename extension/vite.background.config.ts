import { browserTarget, copyManifest, outDir, targetBuild } from './vite.shared.ts'

/**
 * Background：Chrome 加载的是一个 ES module service worker（`"type": "module"`）；
 * Firefox 在 event page 里加载经典脚本，所以同一个入口在那边打成 IIFE。
 * 输出文件名保持完全一致（background.js）。
 */
export default targetBuild(
  'src/background/index.ts',
  browserTarget === 'firefox' ? 'iife' : 'es',
  'background.js',
  true,
)

export { copyManifest, outDir }
