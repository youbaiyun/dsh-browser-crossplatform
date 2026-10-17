// @vitest-environment jsdom

/**
 * 每个语言区域都必须交付同一个身份标识。
 *
 * 只改了三个语言区域文件里的两个，对这个套件里的其他测试来说完全不可见：
 * 浏览器读的是 `_locales/<locale>/messages.json`，而当时没有任何东西对它
 * 做出断言。事情就是这么发生的——`zh_CN` 和 `en` 改了名，`zh_TW` 却留着旧名，
 * 于是繁体中文用户会在扩展页面和工具栏里看到上一个名字。这些测试的存在，就是
 * 为了让下一次改名没法重蹈覆辙。
 *
 * 它们断言形态和一致性，不断言措辞：译者可以按自己语言里读起来最顺的方式
 * 组织描述。被检查的是：每个语言区域都定义了同一组键、没有一个是空的、
 * 而且没有任何语言区域还在用本项目已弃用的名字。
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface LocaleMessage {
  message: string
}

/**
 * 用一个普通目录路径，而不是 `URL`。
 *
 * `new URL('../x', import.meta.url)` 对 `readFile` 可用，对 `readdir` 却不行；
 * 而且在转换之下 `import.meta.url` 并不总是 `file:` URL——这个文件的第一版
 * 就错在这儿：每个测试在读到任何东西之前都以 "The URL must be of scheme file"
 * 失败。在这里转换一次，两次调用就站在同一个立足点上。
 */
const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '_locales')

/**
 * 仓库根目录，用来读它必须保持一致的那份商店文案。
 *
 * 往上两级：这个扩展位于 `<repo>/extension`，不是上游的
 * `<repo>/extensions/dsh-browser`。用三级的话，路径会解析到仓库之上，下面那条断言
 * 就永远被跳过——它本该抓住的漂移，被自己的路径算术藏了起来。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 商店文案的位置——前提是这个 checkout 里有它。
 *
 * 文案属于发布仓库，不属于扩展，所以只含扩展的 checkout 没有可比对的东西。
 * 在那里这条断言报成跳过，而不是删掉，这样一个确实有该文件的 checkout 仍然
 * 能抓住那次导致上传被拒的漂移。
 */
const storeListingPath = join(repoRoot, 'store-assets', 'store-listing.md')
const hasStoreListing = existsSync(storeListingPath)

/**
 * 读商店文案里的简短描述。
 *
 * 商店会检查两份各自独立的简短描述，只要有一份过长就拒收整个提交：一份是在后台
 * 表单里填的，另一份是各语言区域文件里的 `extensionDescription`。它们在这里曾
 * 被分开维护，而英文那份已经漂到 145 个字符，超过了 132 的上限——Chrome 在上传
 * 时以 `语言区域"en"中"description"的翻译太长` 拒了它。在语言区域文件里只保留
 * 一份，并断言它和文案里那份相等，这件事才没法重演。
 */
/**
 * 从商店文案里读出某个语言区域的简短描述。
 *
 * 文案给每个语言区域留一个区块，所以必须指名取哪一节：文件里第一个
 * `### Short description` 是简体中文那一节，因为那是商店的主要语言区域。不指名
 * 的话，这里读到的就是*那一*块，却拿它去和英文的 `extensionDescription` 比，
 * 这条断言对它针对的语言区域根本不可能通过——一次实际上处于关闭状态的漂移
 * 检查。
 *
 * @param locale - 文案自己给该语言区域的标签，例如 `English`。
 * @returns 该节的简短描述，已去掉首尾空白。
 */
const storeShortDescription = async (locale: string): Promise<string> => {
  const markdown = await readFile(storeListingPath, 'utf8')
  // 标签后面的边界用先行断言，不用 `\b`：`English` 不能匹配到更长的标签，
  // 而 CJK 标签压根没有词边界可锚。
  const section = new RegExp(`## Locale: ${locale}(?![\\w\\u4e00-\\u9fff])[\\s\\S]*?### Short description[^\\n]*\\n+\`\`\`\\n([\\s\\S]*?)\\n\`\`\``).exec(markdown)
  if (section === null) throw new Error(`store-listing.md has no short-description code block for ${locale}`)
  return section[1].trim()
}

const readLocale = async (locale: string): Promise<Record<string, LocaleMessage>> =>
  JSON.parse(await readFile(join(localesDir, locale, 'messages.json'), 'utf8')) as Record<string, LocaleMessage>

const allLocales = async (): Promise<string[]> =>
  (await readdir(localesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()

/** 本项目用过、现在已经不用的名字。 */
const RETIRED = ['手與眼', '手与眼', 'Hand & Eye', '浏览器操作', '瀏覽器操作', '浏览器控制', 'Browser Control', 'dsh-browser-lite', 'dsh-browser-crossplatform', '全端', 'all-platform']

describe('locale files', () => {
  it('defines the keys the manifest and the toolbar need, in every locale', async () => {
    const locales = await allLocales()
    // 扩展交付三种语言区域；欢迎再加第四种，但必须完整。
    expect(locales.length).toBeGreaterThanOrEqual(3)
    for (const locale of locales) {
      const messages = await readLocale(locale)
      for (const key of ['extensionName', 'extensionDescription', 'actionTitle']) {
        expect(messages[key]?.message, `${locale}.${key}`).toBeTruthy()
      }
    }
  })

  it('has no empty string in any locale', async () => {
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      for (const [key, value] of Object.entries(messages)) {
        expect(value.message.trim(), `${locale}.${key} must not be blank`).not.toBe('')
      }
    }
  })

  it('states no retired name', async () => {
    // 这正是那次改名需要的检查。它刻意是一份旧名字列表，而不是一组固定的
    // 期望值：重点在于语言区域文件永远不被漏掉，而不在于三者读起来一模一样。
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      const text = JSON.stringify(messages)
      for (const retired of RETIRED) {
        expect(text, `${locale} still says "${retired}"`).not.toContain(retired)
      }
    }
  })

  it('agrees on the name across locales, allowing for each language\'s own wording', async () => {
    // 每个语言区域的名称都必须带上那个不翻译的产品词元。
    // 词元按大小写不敏感比较：它是同一串字母，而句首大写是正常写法 —— 旧版断言小写
    // `dsh`，把 `DSH Browser Extension` 判成错的，失败的理由是断言太紧，不是名字错。
    // 括号里写的是「全平台」，两种中文在这个词上是同一串字；而这个测试的早期版本
    // 拿繁体写法去断言 `zh_CN`，同样是夹具的问题。早先用的「全端」已按改名同步，
    // 旧写法进了 RETIRED，不会悄悄回来。
    const EXPECTED_SUFFIX: Record<string, string> = {
      zh_CN: '全平台',
      zh_TW: '全平台',
    }
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      expect(messages.extensionName.message.toLowerCase(), `${locale} extensionName`).toContain('dsh')
      const suffix = EXPECTED_SUFFIX[locale]
      if (suffix !== undefined) expect(messages.extensionName.message, `${locale} extensionName`).toContain(suffix)
    }
  })

  it('names the localised form of "extension" in the Chinese locales', async () => {
    // 扩展（简体）和 擴充功能（繁体）是浏览器自己的说法；拓展 意为扩展业务，
    // 手與眼 则是本项目旧的比喻。中文语言区域用了别的说法，就是一次漏改的
    // 改名。
    const zhCN = await readLocale('zh_CN')
    const zhTW = await readLocale('zh_TW')
    expect(zhCN.extensionName.message).toContain('扩展')
    expect(zhTW.extensionName.message).toContain('擴充功能')
  })

  it('keeps every description within the store\'s 132-character limit', async () => {
    // Chrome 数的是字符不是字节，而且会拒收整个上传，不会截断。这个上限按
    // 语言区域分别适用。
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      const length = [...messages.extensionDescription.message].length
      expect(length, `${locale} extensionDescription is ${length} characters`).toBeLessThanOrEqual(132)
    }
  })

  it('keeps every name within the store\'s 75-character limit', async () => {
    for (const locale of await allLocales()) {
      const messages = await readLocale(locale)
      const length = [...messages.extensionName.message].length
      expect(length, `${locale} extensionName is ${length} characters`).toBeLessThanOrEqual(75)
    }
  })

  it.skipIf(!hasStoreListing)('states the same short description as the store listing', async () => {
    // 同一段文字，商店会从两个地方读它。两者之间的漂移正是上传被拒的原因，
    // 所以这里断言它们相等，不靠人眼比对。文案用名称而不是语言区域代码来标注
    // 各节，所以这份映射被明确写了出来；没有对应节的语言区域在这里就不检查。
    for (const [locale, section] of [['en', 'English'], ['zh_CN', '中文（简体）'], ['zh_TW', '中文（繁體）']] as const) {
      const listing = await storeShortDescription(section)
      const messages = await readLocale(locale)
      expect(messages.extensionDescription.message, `${locale} vs the listing's ${section} section`).toBe(listing)
    }
  })
})
