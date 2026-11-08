import { isAbsolute } from 'node:path'
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
  deps: {
    /**
     * 发布产物必须自包含：宿主只保证有 Node 内置模块。
     * 从这里加载插件的人（`link:` 源码安装、解压后的目录）不该先跑 `pnpm install`，
     * 所以运行时会引用到的 npm 包全部内联；只有 `node:*` 与相对路径保持外部。
     *
     * 这些包要么是纯构造函数（dsh-home-paths、dsh-llm 的 createUserMessage、
     * dsh-tools 的 defineTool），要么按标准 schema 鸭子类型被宿主消费（schemastery，
     * cordis 用 `Config['~standard'].validate`），内联不会造成实例身份冲突。
     */
    alwaysBundle: (id) => id !== '' && !id.startsWith('node:') && !id.startsWith('.') && !isAbsolute(id),
  },
})
