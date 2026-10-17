// @vitest-environment jsdom
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface ExtensionManifest {
  version: string
  permissions: string[]
  background: Record<string, unknown>
  content_security_policy: { extension_pages: string }
  action?: { default_popup?: string }
  side_panel?: { default_path?: string }
  sidebar_action?: { default_panel?: string }
  browser_specific_settings?: {
    gecko?: {
      strict_min_version?: string
      data_collection_permissions?: { required?: string[] }
    }
  }
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as T
}

/**
 * 两个构建各自的许可证文件。这个 checkout 里还没构建过
 * 扩展时，跳过而不是失败：这条断言讲的是一个构建会附带什么。
 */
const BUILD_LICENCES = ['../dist/LICENSE', '../dist-firefox/LICENSE']
const hasBuilds = BUILD_LICENCES.every((path) => existsSync(new URL(path, import.meta.url)))

describe('Firefox build contract', () => {
  it('keeps release metadata and shared capabilities aligned with Chrome', async () => {
    const [chromeManifest, firefoxManifest, packageManifest] = await Promise.all([
      readJson<ExtensionManifest>('../manifest.json'),
      readJson<ExtensionManifest>('../manifest.firefox.json'),
      readJson<{ version: string }>('../package.json'),
    ])

    expect(firefoxManifest.version).toBe(packageManifest.version)
    expect(firefoxManifest.version).toBe(chromeManifest.version)
    // 上面三者必须一致——这正是这个测试存在的意义。
    // 不直接断言字面值，因为把它钉死在这儿就意味着
    // 每次发布都要改测试，而一次忘记改的发布只会教人
    // 去改期望值，而不是去找原因。必须成立的是：
    // 版本号的形态是商店接受的形态。两个商店都接受一至四个
    // 点分隔的整数，所以像 `0.37` 这样的两段式版本是合法的：这里
    // 固定的是形态，不是段数。
    expect(chromeManifest.version).toMatch(/^\d+(\.\d+){0,3}$/)
    // 面板 API 是唯一合理的差异：Chrome 声明了
    // `sidePanel` 权限，Firefox 没有这种权限可申请。
    expect(firefoxManifest.permissions).toEqual(chromeManifest.permissions.filter((name) => name !== 'sidePanel'))
    expect(chromeManifest.permissions).toContain('sidePanel')
    expect(firefoxManifest.permissions).not.toContain('sidePanel')
    expect(firefoxManifest.permissions).toContain('notifications')
    // 面板只跟本机 bridge 通信，以及跟用户自己的网页已经
    // 加载过的图片主机通信，别的一概没有。`connect-src` 以前还允许
    // raw.githubusercontent.com，却没有一行代码用过它——一项授予给
    // 谁都说不上的权限，所以已从两份 manifest 里移除。规则依然成立：
    // 已发布的扩展不该带上自己并不使用的网络访问权限。
    // 图片抓取正是行使这项权限的地方——桌面的中继带不了
    // 用户的 cookie，所以需要登录的图片只能由 worker 去读。
    expect(firefoxManifest.content_security_policy.extension_pages).toContain('ws://127.0.0.1:*')
    expect(firefoxManifest.content_security_policy.extension_pages).toContain('http://127.0.0.1:*')
    expect(firefoxManifest.content_security_policy.extension_pages).toContain('https:')
    expect(firefoxManifest.content_security_policy.extension_pages).toContain('http:')
    expect(firefoxManifest.content_security_policy.extension_pages).not.toContain('githubusercontent')
    expect(chromeManifest.content_security_policy.extension_pages).not.toContain('githubusercontent')
  })

  it('opens the same panel from the toolbar, through each browser own API', async () => {
    const [chromeManifest, firefoxManifest] = await Promise.all([
      readJson<ExtensionManifest>('../manifest.json'),
      readJson<ExtensionManifest>('../manifest.firefox.json'),
    ])

    // Chrome：侧边面板，没有 popup（popup 会遮住面板，也放不下
    // 这套布局）。Firefox：sidebar，靠浏览器自带的侧边栏按钮
    // 切换，所以同样没有 popup。
    expect(chromeManifest.action?.default_popup).toBeUndefined()
    expect(firefoxManifest.action?.default_popup).toBeUndefined()
    expect(chromeManifest.side_panel?.default_path).toBe('control/index.html')
    expect(firefoxManifest.sidebar_action?.default_panel).toBe('control/index.html')
    expect(firefoxManifest.side_panel).toBeUndefined()
    expect(chromeManifest.sidebar_action).toBeUndefined()
  })

  it('never ships the removed chat client', async () => {
    const [chromeManifest, firefoxManifest] = await Promise.all([
      readJson<ExtensionManifest>('../manifest.json'),
      readJson<ExtensionManifest>('../manifest.firefox.json'),
    ])

    // 这些入口以前归聊天面板；现在控制页是
    // 唯一的 UI，靠上面那些面板 API 到达。
    for (const manifest of [chromeManifest, firefoxManifest]) {
      expect(manifest.action?.default_popup).toBeUndefined()
      expect(JSON.stringify(manifest)).not.toContain('panel/index.html')
      expect(JSON.stringify(manifest)).not.toContain('sidebar_action":{"default_title":"__MSG_actionTitle__","default_panel":"panel')
    }
  })

  it('uses a Firefox event page and AMO data-transmission declaration', async () => {
    const manifest = await readJson<ExtensionManifest>('../manifest.firefox.json')

    expect(manifest.background).toEqual({ scripts: ['background.js'] })
    expect(Number(manifest.browser_specific_settings?.gecko?.strict_min_version?.split('.')[0])).toBeGreaterThanOrEqual(140)
    expect(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required?.sort()).toEqual([
      'browsingActivity',
      'personalCommunications',
      'websiteActivity',
      'websiteContent',
    ])
  })

  it.skipIf(!hasBuilds)('ships the licence notice with both builds, as MIT requires', async () => {
    // 打包后的扩展是一种软件分发形式。本项目是某个
    // MIT 许可项目的衍生作品，所以上游版权行必须出现在
    // 随构建一起分发的声明里——而不只是躺在仓库里。
    for (const path of BUILD_LICENCES) {
      const text = await readFile(new URL(path, import.meta.url), 'utf8')
      expect(text).toContain('MIT License')
      expect(text).toContain('Copyright (c) 2026 Yuxiang Lin')
      expect(text).toContain('Copyright (c) 2026 youbaiyun')
    }
  })
})
