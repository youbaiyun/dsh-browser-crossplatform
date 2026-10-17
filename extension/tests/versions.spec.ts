/**
 * @vitest-environment jsdom
 *
 * 测试套件的共享 setup 会给 `Element.prototype` 和 `CSS` 打桩，所以每个 spec
 * 文件都要 DOM 环境，不管它碰不碰 DOM——包括
 * 这一个，它只读 JSON。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 整棵源码树只用同一个版本号。
 *
 * 仓库的核心主张是：根 package、扩展
 * package 以及两份 manifest 始终一致，这样插件列表、manifest 和
 * 发布 tag 就不可能互相矛盾。它以前就漂移过（manifest 里写着
 * 0.37.1，而源码树说的不是这个），所以这里来断言这个主张，
 * 而不是在散文里重复一遍。
 *
 * 刻意只用文件读取：在这里 import 一个 `.json` 会牵进
 * 测试套件的 jsdom setup，而它需要 `Element`，在 node
 * 环境下并不存在。
 */
const extensionDir = resolve(import.meta.dirname, '..')

function readVersion(relativePath: string): unknown {
  const parsed = JSON.parse(readFileSync(resolve(extensionDir, relativePath), 'utf8')) as { version?: unknown }
  return parsed.version
}

describe('version agreement', () => {
  it('keeps the extension package and both manifests on one version', () => {
    const packageVersion = readVersion('package.json')
    expect(packageVersion).toEqual(expect.any(String))
    expect(readVersion('manifest.json')).toBe(packageVersion)
    expect(readVersion('manifest.firefox.json')).toBe(packageVersion)
  })

  it('keeps the root package and the protocol package on the same version', () => {
    // 协议自己没有 manifest，但它是 README 所说
    // 需要跟着一起改的四个 package 之一。
    expect(readVersion('package.json')).toBe(readVersion('../package.json'))
    expect(readVersion('../packages/protocol/package.json')).toBe(readVersion('../package.json'))
    expect(readVersion('../packages/bridge/package.json')).toBe(readVersion('../package.json'))
    // 基准测试工具是第四个 package。它以前从这个测试里漏掉了，这
    // 正是版本号变更可能悄悄把它落下的原因。
    expect(readVersion('../benchmark/package.json')).toBe(readVersion('../package.json'))
  })
})
