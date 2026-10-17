import { copyManifest, outDir, targetBuild } from './vite.shared.ts'

/** Content script：经典脚本（content script 不能是 ES module）。 */
export default targetBuild('src/content/index.ts', 'iife', 'content.js', false)

export { copyManifest, outDir }
