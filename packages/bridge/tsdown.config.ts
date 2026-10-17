import { defineConfig } from 'tsdown'

/**
 * bridge 发布两个运行时入口：插件本体（index）和它的 invariant 伴生插件。
 * 线上协议现在住在 `@dsh-browser/protocol` 里，并由打包器内联，
 * 所以它不再是本包对外发布的入口。
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
