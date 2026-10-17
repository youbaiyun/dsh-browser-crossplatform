/**
 * 打印构建出的 manifest 所对应的 Chrome 扩展 id。
 *
 * Chrome 由 manifest 的 `key` 推导出未打包/商店版的 id（DER 公钥
 * SHA-256 的前 16 字节，按 0-9a-f → a-p 映射）。bridge
 * 把它的免 token loopback 路径绑定到 `extensionId` 里列出的 id，而
 * `packages/bridge/src/index.ts` 中 `DEFAULT_EXTENSION_IDS` 的第一项
 * 必须等于这里打印的值：正因如此它是一处校验，而不是一个
 * 靠人记住的字符串。
 *
 * `--store` 构建不带 `key`（Chrome 应用商店不接受它），所以它改成打印
 * 商店分配的 id：`agipnijjkpomaannkjkjliggoffdiaf`，也就是
 * 那个列表的第二项。
 *
 * 用法：node extension/scripts/extension-id.mjs [dist|dist-firefox]
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = process.argv[2] ?? 'dist'
const manifestPath = resolve(import.meta.dirname, '..', dir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`${manifestPath} is missing — build that target first`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (typeof manifest.key !== 'string' || manifest.key === '') {
  console.error('this manifest declares no `key`, so Chrome assigns a path-derived id (not comparable)')
  process.exit(1)
}

const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
const id = [...digest.slice(0, 32)].map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16))).join('')
console.log(id)
