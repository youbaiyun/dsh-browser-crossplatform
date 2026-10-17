import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTENSION_IDS } from '../src/index.ts'
import { isTrustedExtensionOrigin } from '../src/server.ts'

/**
 * bridge 只对一个 loopback Origin 跳过它的 bearer token，而这里的 id 是一个常量，
 * 真正的身份住在扩展 manifest 的 `key` 里。除此之外没有任何东西把两者连起来，
 * 所以将来某次构建要是丢掉或换掉这个 key，免 token 通道就会静默失效——扩展会被
 * 以 close code 4002 拒绝，而面板只会说一句“未连接”。
 *
 * 扩展是一个兄弟包：从 npm 单独安装这个插件时，旁边并没有 `extension/`，所以那
 * 种情况下检查会跳过，而不是为一个从未发布过的文件判失败。
 */
const manifestPath = resolve(import.meta.dirname, '../../../extension/manifest.json')

/** Chrome：DER 公钥的 SHA-256，取前 16 字节，把十六进制 0-9a-f 映射成 a-p。 */
function chromeExtensionId(manifestKey: string): string {
  const digest = createHash('sha256').update(Buffer.from(manifestKey, 'base64')).digest('hex')
  return [...digest.slice(0, 32)].map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16))).join('')
}

describe.skipIf(!existsSync(manifestPath))('extension identity', () => {
  it('derives the default token-free id from the extension manifest key', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: unknown }
    expect(manifest.key).toEqual(expect.any(String))
    expect(chromeExtensionId(manifest.key as string)).toBe(DEFAULT_EXTENSION_IDS[0])
  })

  it('keeps the launcher\'s install-detection names equal to those ids', async () => {
    // `browser-launch.ts` 不能导入这个包的入口点（那会构成循环），所以它自己带了
    // 一份副本，用来检查 `<profile>/Extensions/<id>`。任一边漂移都会让 bridge 对一个
    // 确实存在的安装报“未安装”——而那正是用户用来决定该怎么办的那条消息——漏掉
    // 商店 id 就是它以前对每一次商店安装所做的事。
    const launcher = await import('../src/browser-launch.ts')
    expect([...launcher.EXTENSION_DIRECTORY_NAMES]).toEqual([...DEFAULT_EXTENSION_IDS])
  })
})

describe('the token-free origin allowlist', () => {
  const dev = 'kdhkdgfcinfkmogifamoapmheihhcjfk'
  const store = 'agpipnjijkpomaannkijkilggoffdiaf'

  it('accepts every named id, so a store install needs no configuration', () => {
    // 一个构建有两种可能的 id：开发加载由 manifest 的 `key` 钉住，而 Web Store
    // 会拒绝带着那个 key 的 manifest 并分配自己的。两种都必须能用，否则从商店
    // 安装的用户就得手工粘贴一个 token。
    const ids = `${dev},${store}`
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, ids)).toBe(true)
    expect(isTrustedExtensionOrigin(`chrome-extension://${store}`, ids)).toBe(true)
  })

  it('still refuses everything else, which is the whole point of the list', () => {
    // 少了它，这条旁路就变成对 `chrome-extension://` 的前缀匹配，也就是机器上
    // 安装的其他每一个扩展，以及任何设置这个 header 的本地进程。
    const ids = `${dev},${store}`
    expect(isTrustedExtensionOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ids)).toBe(false)
    expect(isTrustedExtensionOrigin(`moz-extension://${dev}`, ids)).toBe(false)
    expect(isTrustedExtensionOrigin('chrome-extension://', ids)).toBe(false)
    // 真实 id 的一个前缀或一次截断都不是真实 id。
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}x`, ids)).toBe(false)
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev.slice(0, -1)}`, ids)).toBe(false)
    expect(isTrustedExtensionOrigin(undefined, ids)).toBe(false)
  })

  it('treats empty, blank and comma-only configuration as "no id configured"', () => {
    // 文档里要求的“处处都要 token”的做法。尾随逗号或多余空格必须无害，而不是
    // 悄悄把 bridge 变成未配置状态；空条目也绝不能匹配一个空 Origin。
    for (const ids of ['', '   ', ',', ' , ']) {
      expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, ids)).toBe(false)
    }
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, ` ${dev} , `)).toBe(true)
    expect(isTrustedExtensionOrigin(`chrome-extension://${dev}`, `${dev},`)).toBe(true)
  })

  it("defaults to naming both of this project's ids", () => {
    expect(DEFAULT_EXTENSION_IDS).toContain(dev)
    expect(DEFAULT_EXTENSION_IDS).toContain(store)
  })

  it('names only well-formed extension ids', () => {
    // 一个 Chrome 扩展 id 恰好是 32 个取自 a-p 的字符。这里两个值里有一个曾经是
    // 31 个字符——第一次抄下来时的笔误——所以它永远匹配不上真实的安装。当时没人
    // 发现，因为从来没有安装过商店构建：免 token 通道一次都没被走到过。一个畸形
    // 的 id 比一个缺失的 id 更糟，因为它读起来像是这条通道能用。
    for (const id of DEFAULT_EXTENSION_IDS) {
      expect(id, `"${id}" must be 32 characters`).toHaveLength(32)
      expect(id, `"${id}" must be a-p only`).toMatch(/^[a-p]{32}$/)
    }
  })
})
