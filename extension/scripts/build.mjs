/**
 * 把三个扩展目标依次构建进 dist/（加了 --firefox 则是 dist-firefox/）：
 * background (es|iife) → content (iife) → control (html popup)。第一个目标会
 * 清空输出；后面的目标追加。开发时反复重建传 --watch。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

// --firefox 会把 manifest 和 background bundle 切到 Firefox 构建。
if (process.argv.includes('--firefox')) {
  process.env.EXT_TARGET = 'firefox'
}

// --store 构建进 dist-store/（或 dist-firefox-store/），并去掉 manifest 里的
// `key`，这正是商店要求的：仓库里的 manifest 带着它来钉住扩展 id，而 Chrome Web
// Store 会拒绝带着它的上传。商店另行分配的 id 才是必须告诉 bridge 的那个。
if (process.argv.includes('--store')) {
  process.env.EXT_STORE = '1'
}

const configs = [
  'vite.background.config.ts',
  'vite.content.config.ts',
  'vite.control.config.ts',
]

/**
 * 通过 Node 跑 Vite，而不是通过 shim。
 *
 * 在当前 Node 上，不加 `shell: true` 就 spawn 不了 `vite.cmd`——Windows 会返回
 * `EINVAL`，而带参数列表的 `shell: true` 已经被弃用（DEP0190），因为参数会被
 * 拼接而不是转义。点名 Vite 的 JavaScript 入口并用同一个 Node 来跑，就把这个问题
 * 消掉了：没有 shell、没有 shim、没有转义，在每个平台上都一样。和
 * `benchmark/lib/browser-install.mjs` 用的是同一个办法，原因也一样。
 */
function viteCommand() {
  const entry = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  if (existsSync(entry)) return { command: process.execPath, prefix: [entry] }
  // 某个被提升安装的依赖可能把它放在别处；回落到 PATH。
  return { command: process.platform === 'win32' ? 'vite.cmd' : 'vite', prefix: [] }
}

const { command, prefix } = viteCommand()

if (watch) {
  // 三个 watcher 并行启动（串行时第一个永不停机，后面的永远不会启动）。
  const children = configs.map((config) => spawn(command, [...prefix, 'build', '--config', config, '--watch'], {
    cwd: root,
    stdio: 'inherit',
  }))
  for (const child of children) {
    child.on('exit', (code) => { if (code !== 0) process.exit(code ?? 1) })
  }
} else {
  for (const config of configs) {
    const result = spawnSync(command, [...prefix, 'build', '--config', config], {
      cwd: root,
      stdio: 'inherit',
    })
    // 一个根本没启动起来的 spawn（二进制缺失、EINVAL）`status === null`，只在
    // `error` 里说明原因；没有这一段的话，构建会以退出码 1 结束却毫无输出，那是
    // 最难调试的失败形式。
    if (result.error !== undefined) {
      console.error(`Could not start the Vite build: ${result.error.message}`)
      process.exit(1)
    }
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
