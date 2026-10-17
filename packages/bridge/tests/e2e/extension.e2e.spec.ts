/**
 * 针对构建出来的扩展、对真实 BridgeServer 做的端到端证明。
 *
 * 检查两件事，按它们相互依赖的顺序：
 *
 * 1. 扩展完成认证，并且一次工具调用被派发出去。起区分作用的信号是失败*代码*：
 *    `bridge-closed` 表示不存在已认证的连接、这次调用从未离开 server，而任何
 *    其他代码都意味着它被派发过了。
 * 2. 图像识别走完整整一圈。只有模型是打桩的——在一个真实 `ImageRelay` 后面的
 *    真实 `VisionClient` 里打桩 `fetch`——所以请求体、解析器、
 *    `image.call`/`image.result` 帧，以及页面文本里的 marker 填充，全都是生产
 *    代码。快照在前后各取一次，于是断言就是：模型产出的描述最终落在文本中那张
 *    图的位置上，并且只有在答案还未知时再问一次才会多花一次请求。
 *
 * 浏览器必须是仍然遵守 `--load-extension` 的那种：Playwright 自带的 Chromium
 * 遵守，而当前系统上的 Chrome/Edge（137+）除非开着开发者模式，否则会忽略它。
 * 设置 `PLAYWRIGHT_CHROMIUM_PATH` 可以钉住某个浏览器。没有可用的浏览器或构建
 * 好的 `extension/dist` 时，它会自行跳过。
 *
 * 这些测试跑的是构建出来的扩展，所以 `pnpm --filter dsh-browser-extension run
 * build` 必须发生在它们*之前*：workspace 的测试脚本不会重新构建，而一份过期的
 * `dist` 会在这里失败，看起来就像源码写错了一样。
 */

import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type LaunchPersistentContextOptions } from 'playwright-core'
import { MAX_DESC_CHARS, THINKING_OFF } from '@dsh-browser/protocol'
import { ImageRelay } from '../../src/image-relay.ts'
import { BridgeServer } from '../../src/server.ts'
import { DEFAULT_EXTENSION_IDS } from '../../src/index.ts'
import { launchBrowser } from '../../src/browser-launch.ts'
import { VisionClient } from '../../src/vision.ts'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../../src/host-api.ts'

/** 扩展会依次探测的端口；本套件绑定第一个空着的。 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189, 19387] as const
/** 只有被测页面会用，所以两个 server 永远不会争端口。 */
const PAGE_PORT = 3081
const TOKEN = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const EXTENSION_DIR = resolve(import.meta.dirname, '../../../../extension/dist')

/** 这个 checkout 里有没有可供本套件驱动的已构建扩展。 */
const hasExtensionBuild = existsSync(join(EXTENSION_DIR, 'manifest.json'))
/** 打桩的模型回答什么，以及测试在文本里找什么。 */
const DESCRIPTION = '完成度达到 50%'
/** 一个透明像素：足够让 `<img>` 拥有字节和尺寸。 */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolveWait) => {
    signal.addEventListener('abort', () => { resolveWait() }, { once: true })
  })
}

let browser: BrowserContext | undefined
let profile: string | undefined
let http: Server | undefined
let pageServer: Server | undefined
let bridge: BridgeServer | undefined
let serving = false
const calls: HostRpcCall[] = []
/** vision 客户端发出的每一个请求，好让请求体可以被检查。 */
const visionRequests: { url: string; body: Record<string, unknown> }[] = []

/** 能让浏览器加载一个 unpacked 扩展的启动选项。 */
function launchOptions(): LaunchPersistentContextOptions {
  const options: LaunchPersistentContextOptions = { headless: true }
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (override !== undefined && existsSync(override)) {
    options.executablePath = override
    // 系统上的 Chrome/Edge 137+ 把这个开关藏在这个 feature flag 后面。
    options.args = ['--disable-features=DisableLoadExtensionCommandLineSwitch']
  } else {
    // 自带的 Chromium 构建仍然原样遵守 --load-extension。
    options.channel = 'chromium'
  }
  options.args = [
    ...(options.args ?? []),
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
  ]
  return options
}

/**
 * 保存本套件需要的设置，然后关闭。
 *
 * 全新的 profile 里什么都没有，而图像识别默认是关的——这个默认是对的，也正是
 * 这里必须先播种设置的原因。在同一次启动期间播种行不通：worker 在启动时只读一次
 * 设置，而一次 reload 会让它完全没有 worker。
 */
/**
 * 写扩展设置。
 *
 * @param profileDir - 一次性浏览器 profile。
 * @param bridgeUrl - 本次测试的桥接地址。必须显式给出：开发机上真实的 dsh 桌面端也会
 *   在 3080 上应答发现请求，扩展会先连上它，而不是这里的测试桥接。
 */
async function seedSettings(profileDir: string, bridgeUrl: string): Promise<void> {
  const context = await chromium.launchPersistentContext(profileDir, launchOptions())
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30_000 })
    await worker.evaluate(async (url) => {
      const stored = await chrome.storage.local.get('dshSettings')
      const current = typeof stored.dshSettings === 'object' && stored.dshSettings !== null
        ? stored.dshSettings as Record<string, unknown>
        : {}
      await chrome.storage.local.set({
        dshSettings: {
          ...current,
          bridgeUrl: url,
          visionTier: 'standard',
          sharePageContent: 'auto',
          // 否则来自 bridge 的工具调用会一直等一个没有测试能答的审批，而面板
          // 会从页面手里抢走活动标签页。
          unrestrictedBrowserAccess: true,
          autoOpenPanel: false,
        },
      })
    }, bridgeUrl)
  } finally {
    await context.close()
  }
}

/** 打桩的模型下一步做什么，好让某个测试自选成功或失败。 */
type StubReply = { kind: 'ok'; content: string } | { kind: 'http'; status: number }
let nextReply: StubReply = { kind: 'ok', content: DESCRIPTION }

/** 一张带两张图的页面，通过 http 提供，好让 content script 能被注入。 */
function startPageServer(): Promise<Server> {
  const server = createServer((req, res) => {
    if ((req.url ?? '') === '/missing.png') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    // 第二张图有另一个地址，这正是缓存眼里它是一张不同的图的原因：身份就是
    // 地址。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>营收看板</title></head><body>
      <h1>本季度营收</h1>
      <p>完成度 30%</p>
      <img src="data:image/png;base64,${PIXEL}" alt="季度营收" style="width:64px;height:64px">
      <img src="data:image/png;charset=utf-8;base64,${PIXEL}" alt="退款率" style="width:64px;height:64px">
      <img src="/missing.png" alt="缺失的图" style="width:64px;height:64px">
    </body></html>`)
  })
  return new Promise<Server>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(PAGE_PORT, '127.0.0.1', () => { resolveListen(server) })
  })
}

/** 从一份快照里，取 alt 文本为 `alt` 的那张图在清单中的下标。 */
function indexOfImage(snapshot: string, alt: string): number {
  const match = new RegExp(`\\[(\\d+)\\] img [^\\n]*"${alt}"`).exec(snapshot)
  return match === null ? Number.NaN : Number(match[1])
}

/** 一次工具调用产出快照文本内容。 */
function textOf(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const text = (result as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

beforeAll(async () => {
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) return

  const api: BrowserHostApi = {
    async call(request): Promise<HostRpcResult> {
      calls.push(request)
      if (request.method === 'session.create') return { ok: true, value: { sessionId: 'session-browser-e2e' } }
      if (request.method === 'session.history') return { ok: true, value: { events: [], hasMore: false } }
      if (request.method === 'session.list') return { ok: true, value: { items: [] } }
      if (request.method === 'workspace.list') return { ok: true, value: { items: [], archivedSessionIds: [] } }
      return { ok: true, value: {} }
    },
    async *events(signal) { await abortWait(signal) },
    async respond() { return { accepted: false, reason: 'not-pending' } },
  }
  // 除了模型之外一切都是真的：relay、请求构造器和解析器都是生产代码，而打桩的
  // fetch 会记录它们发了什么。
  const stubFetch: typeof fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    visionRequests.push({ url: String(input), body })
    if (nextReply.kind === 'http') {
      return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
        status: nextReply.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: nextReply.content } }],
      usage: { completion_tokens_details: { reasoning_tokens: 0 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const vision = new VisionClient(
    {
      model: 'stub-vision',
      // 生产代码从插件配置里取这个 thinking 开关；测试也必须照做，否则它断言的
      // 就是一个没人被要求发送的开关。
      extraBody: THINKING_OFF,
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'stub',
      timeoutMs: 5_000,
    },
    stubFetch,
  )
  bridge = new BridgeServer({
    token: TOKEN,
    // 和生产一致：构建出来的扩展会用 manifest 的 `key` 推导出这个 id，而正是
    // 它让零配置路径可以跳过 token。在这里传上它，本套件测的就是那条路径，而不是
    // token 回落。
    extensionId: DEFAULT_EXTENSION_IDS[0]!,
    api,
    toolTimeoutMs: 20_000,
    caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    policy: { openPagesForUser: true },
    imageRelay: new ImageRelay(vision),
    injectBrowserSnapshot: () => {},
    purgeSession: async () => {},
  })

  const server = createServer((req, res) => {
    if (req.url === '/ext/bridge-config') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${String(boundPort)}/ext/bridge` }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  server.on('upgrade', (req, socket, head) => { bridge?.handleUpgrade(req, socket, head) })
  // 绑定扩展真正会探测的某个端口，而不是专门用 3080：否则一次被中断的运行留下的
  // socket 会变成一个 60 秒的“连不上”失败，而那个失败对原因只字不提。
  let boundPort = 0
  for (const candidate of DISCOVERY_PORTS) {
    // PAGE_PORT 是给下面那个页面 server 的：桥接一旦占了它，两边的 listen 就必然有一个失败。
    // 真实桌面端占住 3080 之后，这里会顺延到 3081——所以必须跳过，而不是靠运气。
    if (candidate === PAGE_PORT) continue
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => { rejectListen(error) }
        server.once('error', onError)
        server.listen(candidate, '127.0.0.1', () => { server.off('error', onError); resolveListen() })
      })
      boundPort = candidate
      break
    } catch {
      // 被别的东西占了；试扩展会发现的下一个端口。
    }
  }
  if (boundPort === 0) {
    await bridge.close()
    bridge = undefined
    console.warn(`SKIP: every discovery port (${DISCOVERY_PORTS.join(', ')}) is already in use`)
    return
  }
  http = server
  pageServer = await startPageServer()
  serving = true

  profile = await mkdtemp(join(tmpdir(), 'dsh-browser-extension-e2e-'))
  try {
    await seedSettings(profile, `ws://127.0.0.1:${String(boundPort)}/ext/bridge`)
    browser = await chromium.launchPersistentContext(profile, launchOptions())
  } catch (error: unknown) {
    console.warn(`SKIP: no browser that loads unpacked extensions is available (${String(error)})`)
    browser = undefined
  }
})

afterAll(async () => {
  await browser?.close()
  await bridge?.close()
  if (http !== undefined) {
    await new Promise<void>((resolveClose) => { http?.close(() => { resolveClose() }) })
  }
  if (pageServer !== undefined) {
    await new Promise<void>((resolveClose) => { pageServer?.close(() => { resolveClose() }) })
  }
  if (profile !== undefined) await rm(profile, { recursive: true, force: true })
})

describe.skipIf(!hasExtensionBuild)('extension ↔ bridge e2e', () => {
  it('authenticates a freshly installed extension and dispatches a tool call', { timeout: 120_000 }, async () => {
    if (!serving || browser === undefined || bridge === undefined) {
      console.warn('SKIP: needs a Chromium that loads extensions, a built extension/dist, and free port 3080')
      return
    }
    const context = browser
    const server = bridge

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30_000 })
    expect(worker.url()).toContain('chrome-extension://')

    let outcome = 'no-connection'
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const value = await server.requestTool('browser_list_tabs', {}, AbortSignal.timeout(2_000), 2_000)
        outcome = `ok:${JSON.stringify(value).slice(0, 160)}`
        break
      } catch (error: unknown) {
        const code = (error as { code?: unknown }).code
        const message = error instanceof Error ? error.message : String(error)
        if (code !== 'bridge-closed') {
          outcome = `${String(code)}:${message.slice(0, 160)}`
          break
        }
      }
      await new Promise((resolve) => { setTimeout(resolve, 2_000) })
    }

    expect(outcome).not.toBe('no-connection')
  })

  it('describes an image through the relay and renders it at the image position', { timeout: 180_000 }, async () => {
    if (!serving || browser === undefined || bridge === undefined || pageServer === undefined) {
      console.warn('SKIP: needs the harness from the previous test')
      return
    }
    const context = browser
    const server = bridge

    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${String(PAGE_PORT)}/`, { waitUntil: 'load' })
    // `load` 保证资源请求都结束了，但"这张图加载失败"这个状态还要由浏览器落到 DOM
    // 上（`complete === true` 而 `naturalWidth === 0`）。快照紧跟 load 时，机器忙起来
    // 就可能读到还没落定的状态，于是 `[load-failed]` 偶发缺失。等到每张图都 complete
    // 再拍，这一层时序问题就不存在了。
    await page.waitForFunction(
      () => Array.from(document.images).every((image) => image.complete),
      null,
      { timeout: 10_000 },
    )

    // 显式跟随刚打开的这一页，不靠 affinity 的"回落到活动标签页"：浏览器刚起来时
    // 那个回落可能挑中启动时的空白页，快照里于是根本没有图，`[load-failed]` 的缺失
    // 会指向完全错误的原因（这条用例确实这样偶发失败过）。
    const listing = textOf(await server.requestTool('browser_list_tabs', {}, AbortSignal.timeout(10_000), 10_000))
    const listingJson = listing.slice(listing.indexOf('{'), listing.lastIndexOf('}') + 1)
    const openTabs = (JSON.parse(listingJson) as { tabs: { tabId: number; url: string }[] }).tabs
    const target = openTabs.find((tab) => tab.url.startsWith(`http://127.0.0.1:${String(PAGE_PORT)}/`))
    expect(target, 'the page just opened must be listed').toBeDefined()
    await server.requestTool('browser_follow_tab', { tabId: target!.tabId }, AbortSignal.timeout(10_000), 10_000)

    const before = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    // 先确认拍的是目标页：上一步若没生效，下面的图片断言会给出误导性的失败原因。
    expect(before).toContain('本季度营收')
    expect(before).toContain('Images:')
    // 这张图还没有被问过任何东西，而文本会把这件事说出来，而不是留下一个要模型
    // 自己去解读的空缺。
    expect(before).toContain('img:not-requested')
    // 这套记号自己解释了含义，并点名了填这个空缺的工具。
    expect(before).toContain('browser_describe_image')
    // 一张页面加载失败的图会被如实报出来，行里和 marker 里都有，而不是从快照里
    // 消失。
    expect(before).toContain('[load-failed]')
    expect(before).toContain('img:unavailable:load-failed')
    const index = indexOfImage(before, '季度营收')
    expect(Number.isInteger(index)).toBe(true)

    const describedText = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(describedText).toContain(DESCRIPTION)
    expect(describedText).toContain('Cross-check against the page text')
    // 页面在图的旁边写的是完成度 30%，而模型回答的是 50%：本地校验必须抓到这一点，
    // 也正是它让这个答案在没有用户参与时不能用于执行动作。
    expect(describedText).toContain('CONFLICT')

    // 模型被问过恰好一次，thinking 关闭，问的就是这张图。
    expect(visionRequests).toHaveLength(1)
    const request = visionRequests[0]!
    expect(request.url).toContain('/chat/completions')
    expect(request.body).toMatchObject({ model: 'stub-vision', temperature: 0, max_tokens: MAX_DESC_CHARS })
    expect(request.body).toMatchObject({ thinking: { type: 'disabled' }, reasoning_effort: 'none' })
    expect(JSON.stringify(request.body)).toContain('data:image/png;base64,')

    // 下一份快照会把描述放在这张图所在的位置。
    const after = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    expect(after).toContain(`img:${DESCRIPTION}`)
    // 只有被问过的那张图有描述；另一张仍然如实说没有，这正是“not-requested”
    // 这句陈述值得说出口的原因。
    expect(indexOfImage(after, '退款率')).toBeGreaterThan(0)
    expect(after).toContain('img:not-requested')

    // 再问一次不花任何代价：答案是这张图的一个属性。
    const again = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(again).toContain(DESCRIPTION)
    expect(visionRequests).toHaveLength(1)
  })

  it('grades a provider failure and a model decline differently', { timeout: 180_000 }, async () => {
    if (!serving || browser === undefined || bridge === undefined || pageServer === undefined) {
      console.warn('SKIP: needs the harness from the previous tests')
      return
    }
    const context = browser
    const server = bridge

    // 上一个测试留下的页面仍然是受控标签页，所以这里用页面上的另一张图，而不是
    // 去开一个 affinity 会忽略的标签页。
    const snapshot = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    const index = indexOfImage(snapshot, '退款率')
    expect(Number.isInteger(index)).toBe(true)

    // provider 失败说明不了这张图的任何事，所以它保持可重试。
    const before = visionRequests.length
    nextReply = { kind: 'http', status: 401 }
    const failed = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(failed).toContain('vision-http')
    expect(failed).toContain('Trying again later may succeed')
    expect(visionRequests.length).toBe(before + 1)

    // 拒绝是一份判决：模型被问过，并回答说自己看不出来。
    nextReply = { kind: 'ok', content: 'UNCLEAR' }
    const declined = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(declined).toContain('vision-unclear')
    expect(declined).toContain('will not be asked about again')

    // 页面文本说同样的事，而且带上原因，而不是沉默下来。
    const after = textOf(await server.requestTool('browser_snapshot', {}, AbortSignal.timeout(30_000), 30_000))
    expect(after).toContain('unavailable:vision-unclear')

    // 而且再问一次不花任何代价：被拒绝的图不会被反复重试成死循环。
    const asked = visionRequests.length
    const skipped = textOf(await server.requestTool(
      'browser_describe_image',
      { index },
      AbortSignal.timeout(30_000),
      30_000,
    ))
    expect(skipped).toContain('vision-skipped')
    expect(visionRequests.length).toBe(asked)

    nextReply = { kind: 'ok', content: DESCRIPTION }
  })

  it('persists a tier chosen in the side panel', { timeout: 120_000 }, async () => {
    if (!serving || browser === undefined) {
      console.warn('SKIP: needs the harness from the previous tests')
      return
    }
    const context = browser
    const worker = context.serviceWorkers()[0]
    expect(worker).toBeDefined()
    const extensionId = /^chrome-extension:\/\/([^/]+)\//.exec(worker!.url())?.[1]
    expect(extensionId).toBeDefined()

    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${String(extensionId)}/control/index.html`, { waitUntil: 'load' })
    // 在没被要求之前，设置页是关着的。
    await panel.locator('[data-role="settings"]').first().click()
    // 靠它的 option value 定位，这样就不依赖测试浏览器恰好报告的是哪种 UI 语言。
    const tier = panel.locator('select:has(option[value="enhanced"])').first()
    await tier.waitFor({ state: 'visible', timeout: 20_000 })
    // 播种的是 `standard`，所以这是一次面板必须落盘的变化。
    await tier.selectOption('enhanced')

    await expect.poll(async () => await worker!.evaluate(async () => {
      const stored = await chrome.storage.local.get('dshSettings')
      const settings = stored.dshSettings as { visionTier?: unknown } | undefined
      return settings?.visionTier
    }), { timeout: 20_000 }).toBe('enhanced')

    await panel.close()
  })
})

/**
 * 启动这条路径，对着真实浏览器和真实扩展演练。
 *
 * **需要显式开启，`DSH_E2E_COLD_START=1`。** 它会按产品的方式启动一个浏览器，
 * 而在开发者的机器上那就是一个他们没要求过的窗口——跑测试套件绝不能背着用户打开
 * 他们的浏览器。CI 会设置这个变量（headless、用一次性 profile）；本地则跳过。
 *
 * 把它排除在上面那套件之外还有第二个原因：它必须观察到“没有扩展连接”，而那套件
 * 自己的 context 正占着连接。第二个 bridge 配第二个 discovery 端口，让两者不会
 * 互相干扰。
 */
const coldStartEnabled = process.env.DSH_E2E_COLD_START === '1'
describe.skipIf(!hasExtensionBuild || process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined || !coldStartEnabled)('cold start', () => {
  it('starts a closed browser and the extension connects by itself', { timeout: 180_000 }, async () => {
    const browserExe = process.env.PLAYWRIGHT_CHROMIUM_PATH
    if (browserExe === undefined) return

    const api: BrowserHostApi = {
      async call() { return { ok: true, value: {} } },
      async *events(signal: AbortSignal) { await abortWait(signal) },
      async respond() { return { accepted: false, reason: 'not-pending' } },
    }
    const bridge = new BridgeServer({
      token: TOKEN,
      extensionId: DEFAULT_EXTENSION_IDS[0]!,
      api,
      toolTimeoutMs: 20_000,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
      policy: { openPagesForUser: true },
      injectBrowserSnapshot: () => {},
      purgeSession: async () => {},
    })
    // 第一套 harness 占着 3080、页面 server 占着 3081，所以这个冷启动 bridge 取
    // 扩展同样会探测的下一个端口。
    const port = DISCOVERY_PORTS.find((candidate) => candidate !== 3080 && candidate !== 3081)
    if (port === undefined) throw new Error('the discovery port list has no spare entry')
    const server = createServer((req, res) => {
      if (req.url === '/ext/bridge-config') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${String(port)}/ext/bridge` }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })

    const profile = await mkdtemp(join(tmpdir(), 'dsh-browser-cold-start-'))
    try {
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen)
          server.listen(port, '127.0.0.1', resolveListen)
        })
      } catch {
        // 另一个进程占着那个端口；跳过，而不是去测错误的那个。
        console.warn(`SKIP: discovery port ${String(port)} is in use`)
        return
      }
      expect(bridge.hasConnection()).toBe(false)

      const outcome = await launchBrowser(
        {
          executablePath: browserExe,
          extensionPath: EXTENSION_DIR,
          userDataDir: profile,
          // 这台 CI 主机没有显示器；启动器是自己去 spawn 进程的，所以必须告诉
          // 它，不像 Playwright 的启动会默认这一点。
          headless: true,
          timeoutMs: 60_000,
          // 检测会找到一个系统上的 Chrome，而它根本加载不了 unpacked 扩展；
          // 上面那个可执行文件才是能加载的。
        },
        () => bridge.hasConnection(),
      )
      expect(outcome.message).not.toContain('failed')
      expect(outcome.connected).toBe(true)

      // 而且这条连接是可用的，不只是存在而已。
      const tabs = textOf(await bridge.requestTool('browser_list_tabs', {}, AbortSignal.timeout(20_000), 20_000))
      expect(tabs).toContain('127.0.0.1')
    } finally {
      await bridge.close()
      await new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
      // 一个刚刚退出的浏览器在 Windows 上仍可能占着一个 crashpad 文件；清理失败
      // 绝不能把一个本来通过的测试变成失败的。
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    }
  })
})
