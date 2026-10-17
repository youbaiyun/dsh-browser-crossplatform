import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { apply, assertPositiveInteger, buildVisionClient, BROWSER_PROMPT_MARKER_RULE, BROWSER_PROMPT_PREAMBLE, BROWSER_TASK_LIST_RULE, Config, DEFAULT_EXTENSION_IDS, DISCOVERY_PORTS, resolveConfig, resolveVisionClient, startDiscoveryListener } from '../src/index.ts'
import type { BridgeServer } from '../src/server.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH, VISION_MODEL } from '@dsh-browser/protocol'

/** 最小化的 context 桩：apply 在注册时只需要那几个 service。 */
function stubContext(): Context {
  const gateway = {
    wireStream: {
      open: async (): Promise<AsyncIterable<unknown>> => ({
        async *[Symbol.asyncIterator]() { yield { type: 'ready', clientId: 'test', host: { home: '/tmp' } } },
      }),
      failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }),
    },
    invoke: async () => undefined,
  }
  const connection = {
    createSharedFetchHandler: () => ({ fetch: async () => new Response('not found', { status: 404 }) }),
  }
  return {
    webServer: { port: 0, registerUpgrade: () => () => {}, register: () => () => {} },
    tools: { register: () => () => {} },
    agents: { get: () => undefined },
    get: (key: string) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined,
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown, label?: string) => {
      void label
      return fn() as () => void
    },
  } as unknown as Context
}

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('system prompt text', () => {
  it('keeps the assembled section ASCII-only, so a page has no homoglyph to smuggle', () => {
    // 扩展会用 origin marker 标记用户面板的输入；那个 marker 是刻意不写进提示词
    // 的，所以提示词本身必须保持纯 ASCII。
    for (const [label, text] of [['preamble', BROWSER_PROMPT_PREAMBLE], ['marker rule', BROWSER_PROMPT_MARKER_RULE], ['task list rule', BROWSER_TASK_LIST_RULE]] as const) {
      const offenders = [...text].filter((character) => character.charCodeAt(0) > 0x7f)
      expect(offenders, `${label} must stay ASCII-only: found ${offenders.join('')}`).toEqual([])
    }
  })

  it('describes the marker by origin instead of quoting it', () => {
    expect(BROWSER_PROMPT_MARKER_RULE).toContain('origin marker')
    // 一个被原样引用的字面 marker 会把那个可以拿来冒充的精确字符串交给页面。
    expect(BROWSER_PROMPT_MARKER_RULE).not.toContain('[用户')
    expect(BROWSER_PROMPT_PREAMBLE).not.toContain('[用户')
  })
})

describe('assertPositiveInteger', () => {
  it('accepts positive integers and rejects everything else', () => {
    expect(() => assertPositiveInteger('x', 1)).not.toThrow()
    expect(() => assertPositiveInteger('x', 0)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', -1)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', 1.5)).toThrow(/must be a positive integer/)
  })
})

/** 合法的预算值（Loader 会套用 schema 默认值；手工构造的测试显式传入它们）。 */
// `discoveryListener: false` 是测试专用的：apply 的用例不该真去绑 3080 那几个端口。
const VALID = { toolTimeoutMs: 90_000, snapshotMaxChars: 32_000, maxInteractiveItems: 60, discoveryListener: false }

/** 在配置 key 之前看图是关着的，所以它的默认值是无害的。 */
const VISION_DEFAULTS = {
  visionApiKey: '',
  visionBaseUrl: 'https://api.deepseek.com/v1',
  visionModel: VISION_MODEL,
  visionThinking: 'off',
  visionTimeoutMs: 20_000,
}

/** 在配置浏览器之前启动是关着的；检测发生在启动那一刻。 */
const LAUNCH_DEFAULTS = {
  browserExecutablePath: '',
  extensionPath: '',
  browserUserDataDir: '',
  browserLaunchArgs: [],
  browserHeadless: false,
  browserLaunchTimeoutMs: 25_000,
}

describe('vision source', () => {
  it('prefers a configured key and never asks the credential service', async () => {
    const client = await resolveVisionClient(
      { get: () => { throw new Error('the credential service must not be consulted when a key is configured') } },
      resolveConfig({ ...VALID, visionApiKey: 'configured' }),
    )
    expect(client).toBeDefined()
  })

  it('falls back to the credential the desktop already holds', async () => {
    // 名字是 `DEEPSEEK_API_KEY`：一个 CredentialRef 就是一个环境变量名，环境变量
    // 之上还叠了受管存储和 `.env` 文件。
    const asked: string[] = []
    const client = await resolveVisionClient({
      get: (name) => name === 'credentials'
        ? { resolve: async (ref: string) => { asked.push(ref); return { value: 'from-store', source: 'store' } } }
        : undefined,
    }, resolveConfig({ ...VALID }))
    expect(client).toBeDefined()
    expect(asked).toEqual(['DEEPSEEK_API_KEY'])
  })

  it('never borrows the account token, which the public API rejects', async () => {
    // 第一个回落分支问的是 `deepseekAccount`，拿到的是一个平台 token；API 于是对
    // 一个没人写过的 key 回了 401。那个 service 绝不能被问。
    const client = await resolveVisionClient({
      get: (name) => {
        if (name === 'deepseekAccount') throw new Error('the account service must not be used')
        return undefined
      },
    }, resolveConfig({ ...VALID }))
    expect(client).toBeUndefined()
  })

  it('stays unavailable when the credential resolves to nothing', async () => {
    const config = resolveConfig({ ...VALID })
    expect(await resolveVisionClient({ get: () => undefined }, config)).toBeUndefined()
    expect(await resolveVisionClient({ get: () => ({ resolve: async () => undefined }) }, config)).toBeUndefined()
    expect(await resolveVisionClient({
      get: () => ({ resolve: async () => ({ value: '   ', source: 'x' }) }),
    }, config)).toBeUndefined()
    expect(await resolveVisionClient({
      get: () => ({ resolve: async () => { throw new Error('no store') } }),
    }, config)).toBeUndefined()
  })

  it('names one image-capable model, by its API id, as the default that can be overridden', () => {
    // `deepseek-v4.1-flash` 是展示名，会返回 400；API 列出的则是
    // `deepseek-flash` 和 `deepseek-v4-pro`，而只有前者接受图片。
    expect(VISION_MODEL).toBe('deepseek-flash')
    // 未设置或被清空都会解析成那个 id，所以一个没人配置过的安装——以及一个字段被
    // 清空的配置——都是正确的，而不是坏的。
    expect(resolveConfig({ ...VALID }).visionModel).toBe('deepseek-flash')
    expect(resolveConfig({ ...VALID, visionModel: '' }).visionModel).toBe('deepseek-flash')
    // 但这个字段是可配置的，因为 `visionBaseUrl` 也是：把它指向另一个 provider 而
    // id 还固定着，就会发过去一个那个 provider 从没听说过的名字。错的 id 不会
    // 悄无声息——provider 自己的 400 会列出它接受的名字，这一个就是这么被发现的。
    expect(resolveConfig({ ...VALID, visionModel: 'custom-vision' }).visionModel).toBe('custom-vision')
  })

  it('falls back rather than throwing when a direct caller passes a non-string model', () => {
    // Loader 总是先跑 schema，但手工构造的配置从来不跑，而以前对一个数字调
    // `.trim()` 会抛 TypeError，替换掉的那个 `??` 写法则只是取回落值。
    const handBuilt = { ...VALID, visionModel: 42 } as unknown as Config
    expect(resolveConfig(handBuilt).visionModel).toBe('deepseek-flash')
  })

  it('asks for thinking off by default', () => {
    // 在感知类任务上，推理 token 的开销比图本身还大。
    expect(resolveConfig({ ...VALID }).visionThinking).toBe('off')
  })
})

describe('config', () => {
  it('resolves defaults, including an enabled workspace under the dsh home', () => {
    expect(resolveConfig({})).toEqual({
      ...VALID,
      sessionWorkspacePath: dshHomePath('browser-sessions'),
      // 要有名字，否则这个分组会以它的目录名出现。
      sessionWorkspaceTitle: '浏览器对话',
      deferSessionCreate: true,
      // 除非用户关掉它，否则模型会替用户打开页面。
      openPagesForUser: true,
      // 被点名的扩展可以在 loopback 上跳过 token；别的都不行。开发用 id（由
      // manifest 的 `key` 钉住）和 Chrome Web Store 的 id 都被点名了，因为商店
      // 安装不能带上那个 key，否则就得手工配置。
      extensionId: DEFAULT_EXTENSION_IDS.join(','),
      ...VISION_DEFAULTS,
      ...LAUNCH_DEFAULTS,
      // 默认在扩展探测的那几个固定端口上再开一个监听；关掉它，扩展就只能靠宿主端口
      // 碰巧落进那份列表来连上。
      discoveryListener: true,
      discoveryPorts: [...DISCOVERY_PORTS],
    })
    expect(new Config().sessionWorkspacePath).toBe(dshHomePath('browser-sessions'))
    expect(new Config().sessionWorkspaceTitle).toBe('浏览器对话')
  })

  it('preserves explicit values and the empty-string workspace opt-out', () => {
    expect(resolveConfig({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      sessionWorkspaceTitle: '',
      deferSessionCreate: false,
      openPagesForUser: false,
      visionApiKey: 'secret',
      visionBaseUrl: '',
      visionModel: 'custom-vision',
      visionThinking: 'low',
      visionTimeoutMs: 1_000,
      extensionId: '',
      browserExecutablePath: '/opt/custom/chrome',
      extensionPath: '/opt/ext/dist',
      browserUserDataDir: '/home/user/.dsh/browser-profile',
      browserLaunchArgs: ['--no-first-run'],
      browserHeadless: true,
      browserLaunchTimeoutMs: 5_000,
      discoveryListener: false,
      discoveryPorts: [4_321],
    })).toEqual({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      sessionWorkspaceTitle: '',
      deferSessionCreate: false,
      openPagesForUser: false,
      visionApiKey: 'secret',
      visionBaseUrl: '',
      visionModel: 'custom-vision',
      visionThinking: 'low',
      visionTimeoutMs: 1_000,
      // 空字符串这种退出方式必须保留下来：它让 token 变成强制项。
      extensionId: '',
      browserExecutablePath: '/opt/custom/chrome',
      extensionPath: '/opt/ext/dist',
      browserUserDataDir: '/home/user/.dsh/browser-profile',
      browserLaunchArgs: ['--no-first-run'],
      browserHeadless: true,
      browserLaunchTimeoutMs: 5_000,
      discoveryListener: false,
      discoveryPorts: [4_321],
    })
    expect(new Config({ sessionWorkspacePath: '' }).sessionWorkspacePath).toBe('')
  })

  it('rejects a thinking setting the caller would silently misread', () => {
    expect(() => resolveConfig({ visionThinking: 'medium' })).toThrow(/visionThinking/)
  })

  it('rejects a launch timeout that cannot be waited on', () => {
    expect(() => resolveConfig({ browserLaunchTimeoutMs: 0 })).toThrow(/browserLaunchTimeoutMs/)
    expect(() => resolveConfig({ browserLaunchTimeoutMs: 1.5 })).toThrow(/browserLaunchTimeoutMs/)
  })

  it('builds no vision client without a key, and one when a key is present', () => {
    expect(buildVisionClient(resolveConfig({}))).toBeUndefined()
    expect(buildVisionClient(resolveConfig({ visionApiKey: 'secret' }))).toBeDefined()
  })
})

describe('apply', () => {
  it('registers the bridge and mints no token when one is configured', async () => {
    const ctx = stubContext()
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(home)
    vi.stubEnv('DSH_HOME', home)
    await apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })
    // 桥接必须真的挂上 upgrade 路由，否则"注册成功"无从谈起——这条用例原先只调用
    // apply() 而不检查任何东西，等于只证明了"没有抛异常"。
    expect(register).toHaveBeenCalledTimes(1)
    // 配置里给了 token 就不该再铸一个并落盘；"no generation" 要由磁盘来回答。
    expect(existsSync(join(home, 'ext-bridge-token'))).toBe(false)
  })

  it.each([undefined, {}, { wireStream: {} }])('rejects unsupported Gateway capabilities: %j', async (gateway) => {
    const ctx = stubContext()
    const get = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation((key) => key === 'typertGateway' ? gateway : get(key))
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await expect(apply(ctx, { token: 'fixed-token', ...VALID })).rejects.toThrow(/dsh 0\.2\.0-rc\.1.*wireStream unavailable/)
    expect(register).not.toHaveBeenCalled()
  })

  it('leaves Remote event source ownership to the host composition', async () => {
    const ctx = stubContext()
    const gateway = ctx.get('typertGateway')
    const open = vi.spyOn(gateway.wireStream, 'open')

    await apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })

    expect(open).not.toHaveBeenCalled()
  })

  it('generates and persists a token when none is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(home)
    vi.stubEnv('DSH_HOME', home)
    await apply(stubContext(), VALID)
    // 真正的断言在磁盘上：没配置 token 时必须铸一个并持久化，否则下一次启动会换一个
    // 新 token，已经装好的扩展就再也连不上。这条用例原先什么都没检查。
    const file = join(home, 'ext-bridge-token')
    expect(existsSync(file)).toBe(true)
    // 256 位十六进制；空文件、或只写了一半，都会被这条挡下。
    expect(readFileSync(file, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('treats every dsh peer as host-provided and optional, never as an exact pin', () => {
    // dsh 是宿主：这些包在运行时由它提供（构建产物里就是裸 import），所以安装期不该
    // 由 npm 来裁定版本。而且这里有个 semver 陷阱——带预发布标签的版本（当前桌面版
    // `0.2.1-rc.2` 就是）**不满足**任何 `>=0.2.0-rc.2 <0.3.0` 这类范围，`*` 和 `0.2.x`
    // 也一样排除它。所以光放宽范围不够：必须标成 optional，范围只作文档。
    // 真正把关的是挂载时的能力检查（`gateway.wireStream`）以及下面那条"缺服务时的
    // 降级/报错"。这条测试防的是有人把它改回精确锁。
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/'))
    expect(peers.length).toBeGreaterThan(0)
    for (const [name, range] of peers) {
      expect(pkg.peerDependenciesMeta?.[name]?.optional, `${name} must be optional`).toBe(true)
      expect(range, `${name} must not be an exact pin`).not.toMatch(/^\d+\.\d+\.\d+(-\S+)?$/)
    }
  })

  it('mounts without an agent registry, and says so instead of failing', async () => {
    // 不同 dsh 版本暴露的 Context 面并不一致。`agents` 只驱动"把浏览器快照注入对话"
    // 这个便利功能；缺了它，插件仍应完整可用，缺的只是自动注入。这条同时钉住"缺服务
    // 时不抛"——否则用户装上新 dsh 会看到插件直接加载失败。
    const ctx = stubContext()
    delete (ctx as { agents?: unknown }).agents
    const warn = vi.spyOn(ctx.logger, 'warn')
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })
    expect(register).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent registry'))
  })

  it('waits for the gateway instead of throwing when dsh injects the services later', async () => {
    // 新版 dsh 通过依赖注入暴露 gateway/connection，插件上下文里 `ctx.get` 可能先拿到
    // undefined。原来这里直接 throw，插件于是静默不挂载——桌面端 web 服务上没有
    // `/ext/bridge-config`，扩展只能显示「未连接」，用户和日志都看不到原因。
    const ctx = stubContext()
    const deps: string[][] = []
    const callbacks: Array<() => void> = []
    const realGateway = ctx.get('typertGateway')
    const realConnection = ctx.get('connection')
    let ready = false
    ;(ctx as unknown as Record<string, unknown>).inject = (list: readonly string[], callback: () => void): void => {
      deps.push([...list])
      callbacks.push(callback)
    }
    ;(ctx as unknown as Record<string, unknown>).get = (key: string): unknown => {
      if (key === 'typertGateway') return ready ? realGateway : undefined
      if (key === 'connection') return ready ? realConnection : undefined
      return undefined
    }

    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await expect(apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })).resolves.toBeUndefined()
    // 没有抛错，而是声明了它需要的两个服务。
    expect(deps[0]).toEqual(['typertGateway', 'connection'])
    expect(register).not.toHaveBeenCalled()

    // 宿主后来提供了服务 → 回调执行 → 桥接真的挂上。
    ready = true
    callbacks[0]!()
    await vi.waitFor(() => { expect(register).toHaveBeenCalledTimes(1) })
  })

  it('rejects invalid budgets loudly', async () => {
    await expect(apply(stubContext(), { ...VALID, toolTimeoutMs: 0 })).rejects.toThrow(/toolTimeoutMs/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: -1 })).rejects.toThrow(/snapshotMaxChars/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: 499 })).rejects.toThrow(/at least 500/)
  })
})

/** 找一个当前空闲的端口，免得用例之间互相抢。 */
async function freePort(): Promise<number> {
  const probe = createHttpServer()
  await new Promise<void>((done) => { probe.listen(0, '127.0.0.1', () => { done() }) })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((done) => { probe.close(() => { done() }) })
  return port
}

describe('fixed-port discovery', () => {
  it('serves the same discovery document and hands upgrades to the bridge', async () => {
    const port = await freePort()
    const handleUpgrade = vi.fn()
    const warn = vi.fn()
    const listener = startDiscoveryListener(
      { handleUpgrade } as unknown as BridgeServer,
      [port],
      warn,
    )
    try {
      await expect(listener.ready).resolves.toBe(true)
      const response = await fetch(`http://127.0.0.1:${port}${BRIDGE_CONFIG_PATH}`)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        wsUrl: `ws://127.0.0.1:${port}${BRIDGE_PATH}`,
      })

      // 这个端口上只有发现端点，别的一律 404。
      expect((await fetch(`http://127.0.0.1:${port}/api`)).status).toBe(404)

      const socket = connect(port, '127.0.0.1')
      await once(socket, 'connect')
      socket.write(
        `GET ${BRIDGE_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + `Origin: chrome-extension://${DEFAULT_EXTENSION_IDS[0]}\r\n\r\n`,
      )
      await vi.waitFor(() => { expect(handleUpgrade).toHaveBeenCalledTimes(1) })
      socket.destroy()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      await listener.close()
    }

    // 关闭后端口必须真的放回去，否则一次 dsh 重启就永久少一个发现端口。
    const probe = createHttpServer()
    await new Promise<void>((done, fail) => {
      probe.once('error', fail)
      probe.listen(port, '127.0.0.1', () => { done() })
    })
    await new Promise<void>((done) => { probe.close(() => { done() }) })
  })

  it('skips a taken port and uses the next one', async () => {
    const first = await freePort()
    let second = await freePort()
    // 两次探测可能拿回同一个端口；那样就变成"全被占"，测不到"换下一个"。
    while (second === first) second = await freePort()
    const blocker = createHttpServer()
    await new Promise<void>((done) => { blocker.listen(first, '127.0.0.1', () => { done() }) })
    const warn = vi.fn()
    const listener = startDiscoveryListener(
      { handleUpgrade: vi.fn() } as unknown as BridgeServer,
      [first, second],
      warn,
    )
    try {
      await expect(listener.ready).resolves.toBe(true)
      const response = await fetch(`http://127.0.0.1:${second}${BRIDGE_CONFIG_PATH}`)
      expect(response.status).toBe(200)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      await listener.close()
      await new Promise<void>((done) => { blocker.close(() => { done() }) })
    }
  })

  it('rejects a port list it cannot bind rather than crashing the host', async () => {
    const port = await freePort()
    const blocker = createHttpServer()
    await new Promise<void>((done) => { blocker.listen(port, '127.0.0.1', () => { done() }) })
    const warn = vi.fn()
    try {
      const listener = startDiscoveryListener(
        { handleUpgrade: vi.fn() } as unknown as BridgeServer,
        [port],
        warn,
      )
      await expect(listener.ready).resolves.toBe(false)
      await listener.close()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('none of the discovery ports'))
    } finally {
      await new Promise<void>((done) => { blocker.close(() => { done() }) })
    }
  })

  it('rejects a discovery port outside the valid range', () => {
    expect(() => resolveConfig({ ...VALID, discoveryPorts: [0] })).toThrow(/discoveryPorts/)
    expect(() => resolveConfig({ ...VALID, discoveryPorts: [70_000] })).toThrow(/discoveryPorts/)
    expect(() => resolveConfig({ ...VALID, discoveryPorts: [1.5] })).toThrow(/discoveryPorts/)
  })

  it('keeps the extension probe list and the bridge default in step', () => {
    expect([...DISCOVERY_PORTS]).toEqual([3080, 3081, 3090, 14389, 43189, 19387])
  })
})
