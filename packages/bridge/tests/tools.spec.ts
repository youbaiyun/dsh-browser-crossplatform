import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from '../src/tools.ts'

describe('registerBrowserTools', () => {
  function makeHarness() {
    const registered: { name: string; definition: Record<string, unknown> }[] = []
    const ctx = {
      tools: {
        register: vi.fn((definition: { name: string }) => {
          registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
          return () => {}
        }),
      },
    } as unknown as Context
    const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, _timeoutMs?: number): Promise<unknown> => {
      return { text: 'ok' }
    })
    // 默认视为有一个已连接的扩展：否则那个会尝试启动浏览器的 preflight，只在
    // 这里说没有连接时才会跑。
    const bridge = { requestTool, hasConnection: () => true } as unknown as BridgeServer
    return { ctx, bridge, requestTool, registered }
  }

  /** 每个用例共用的选项：预算值加上启动开关。 */
  const OPTIONS = { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true }

  it('registers the full v1 tool set', () => {
    const { ctx, bridge, registered } = makeHarness()
    const disposers = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    expect(registered.map((r) => r.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
    expect(disposers.size).toBe(BROWSER_TOOL_NAMES.length)
    for (const dispose of disposers.values()) dispose()
  })

  it('executes browser_click with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ index: 3, frame: 7 }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_click', { index: 3, frame: 7 }, exec.signal, 1_000)
    expect(result).toEqual({ text: 'ok' })
  })

  it('associates browser calls with the owning Agent session', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-browser' },
    }

    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

    expect(requestTool).toHaveBeenCalledWith(
      'browser_click',
      { index: 3 },
      exec.signal,
      1_000,
      'session-browser',
    )
  })

  it('normalizes snapshot args (delta/region omitted when absent)', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', {}, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true, region: 'main' }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true, region: 'main' }, exec.signal, 1_000)
  })

  it('executes every remaining tool with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: unknown): Promise<void> => {
      await (byName.get(name)!.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)(args, exec)
    }

    await run('browser_type', { index: 2, text: 'hello' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello' }, exec.signal, 1_000)
    await run('browser_type', { index: 2, text: 'hello', replace: true })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello', replace: true }, exec.signal, 1_000)
    await run('browser_type', { index: 2, frame: 4, text: 'inside frame' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, frame: 4, text: 'inside frame' }, exec.signal, 1_000)

    await run('browser_press', { key: 'Enter' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_press', { key: 'Enter' }, exec.signal, 1_000)

    await run('browser_scroll', { direction: 'down', amount: 200 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', amount: 200 }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'top' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'top' }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'down', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', frame: 4 }, exec.signal, 1_000)

    await run('browser_navigate', { url: 'https://example.com' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_navigate', { url: 'https://example.com' }, exec.signal, 1_000)
    await run('browser_open_tab', { url: 'https://example.com/new' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_open_tab', { url: 'https://example.com/new' }, exec.signal, 1_000)
    await run('browser_open_tab', { url: 'https://example.com/bg', active: false })
    expect(requestTool).toHaveBeenLastCalledWith(
      'browser_open_tab',
      { url: 'https://example.com/bg', active: false },
      exec.signal,
      1_000,
    )

    await run('browser_list_tabs', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_list_tabs', {}, exec.signal, 1_000)
    await run('browser_follow_tab', { tabId: 17 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_follow_tab', { tabId: 17 }, exec.signal, 1_000)
    await run('browser_close_tab', { tabId: 18 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_close_tab', { tabId: 18 }, exec.signal, 1_000)

    for (const name of ['browser_back', 'browser_forward', 'browser_reload'] as const) {
      await run(name, {})
      expect(requestTool).toHaveBeenLastCalledWith(name, {}, exec.signal, 1_000)
    }

    await run('browser_get_text', { selector: '#main' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: '#main' }, exec.signal, 1_000)
    await run('browser_get_text', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', {}, exec.signal, 1_000)
    await run('browser_get_text', { selector: 'main', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: 'main', frame: 4 }, exec.signal, 1_000)

    await run('browser_wait', { ms: 100 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { ms: 100 }, exec.signal, 1_000)
    await run('browser_wait', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', {}, exec.signal, 1_000)
    await run('browser_wait', { frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { frame: 4 }, exec.signal, 1_000)
  })

  it('normalizes every DSH parameter map to JSON Schema before registration', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    for (const { definition } of registered) {
      const params = definition.parameters as { type?: unknown; properties?: unknown }
      expect(params.type).toBe('object')
      expect(params.properties).toBeDefined()
    }
    const click = registered.find(({ name }) => name === 'browser_click')!.definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(click.properties.index).toBeDefined()
    expect(click.required).toContain('index')
  })

  it('declares cooperative timeoutMs on every tool', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    for (const { definition } of registered) {
      expect(definition.timeoutMs).toBe(5_000)
    }
  })

  it('keeps model-facing tool schemas in English', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const han = /\p{Script=Han}/u
    for (const { definition } of registered) {
      expect(String(definition.description)).not.toMatch(han)
      expect(JSON.stringify(definition.parameters)).not.toMatch(han)
    }
  })

  it('keeps model-facing tool descriptions concise', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const descriptionChars = registered.reduce((sum, { definition }) => sum + String(definition.description).length, 0)
    // 这是一个预算，不是风格规则：它存在的意义是让整个工具面没法在没人注意的
    // 情况下悄悄膨胀。它覆盖模型看到的每一个工具（目前 17 个），加上在读取类工具
    // 上重复出现的那句不可信内容警告，而 `browser_wait` 和 `browser_launch` 确实
    // 各自都需要一句关于时序和限制的话。
    expect(descriptionChars).toBeLessThan(2_000)
  })

  it('answers browser_launch without dispatching when the extension is already connected', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, OPTIONS)
    const tool = registered.find((r) => r.name === 'browser_launch')!
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, { signal: new AbortController().signal })
    expect(requestTool).not.toHaveBeenCalled()
    expect(result).toEqual({ text: expect.stringContaining('already running') })
  })

  it('does not open a window it cannot prove is missing', async () => {
    // 在问不到答案的平台上，这个探测会返回 undefined；那时启动会打开一个没人
    // 要求过的窗口，所以答案仍然是“已在运行”。
    const { ctx, bridge, registered } = makeHarness()
    const spawn = vi.fn()
    registerBrowserTools(ctx, bridge, {
      ...OPTIONS,
      launcher: { visibleWindow: async () => undefined, spawnDetached: spawn, exists: () => true },
    })
    const tool = registered.find((r) => r.name === 'browser_launch')!
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, { signal: new AbortController().signal })
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({ text: expect.stringContaining('already running') })
  })

  it('launches when the connected browser has no window left, instead of claiming it is running', async () => {
    // 一个 Chromium 进程会比它最后一个窗口活得更久，而扩展一直把 socket 开着，
    // 于是对一个眼前没有任何浏览器的用户报了“已连接、已在运行”——接着每个页面
    // 工具都失败于“没有活动标签页”。在明确知道“没有窗口”时，让浏览器再启动一次
    // 才是把窗口找回来的办法。
    const { ctx, bridge, registered } = makeHarness()
    const spawn = vi.fn()
    registerBrowserTools(ctx, bridge, {
      ...OPTIONS,
      launcher: {
        visibleWindow: async () => false,
        spawnDetached: spawn,
        exists: () => true,
        // 从启动器的角度看没有任何东西在运行：不见的是窗口，而请一个常驻进程再
        // 启动一次，是把窗口找回来的唯一办法。
        probeRunning: async () => [],
        waitForConnection: async () => true,
      },
    })
    const tool = registered.find((r) => r.name === 'browser_launch')!
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, { signal: new AbortController().signal })
    expect(spawn).toHaveBeenCalledTimes(1)
    // 而且答案不是这个用例以前会产出的那句“已在运行”。
    expect(JSON.stringify(result)).not.toContain('already running')
  })

  it('turns a lost connection into instructions instead of a transport error', async () => {
    // preflight 的意义：没有配置启动器时，一个对已关闭浏览器调用 browser_snapshot
    // 的模型必须拿到点能据以行动的东西。
    const { ctx, registered } = makeHarness()
    const bridge = { requestTool: vi.fn(), hasConnection: () => false } as unknown as BridgeServer
    registerBrowserTools(ctx, bridge, OPTIONS)
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, { signal: new AbortController().signal })
    expect(bridge.requestTool).not.toHaveBeenCalled()
    expect(String((result as { text: string }).text)).toContain('open their browser')
  })

  it('does not start a browser when the user turned page-opening off', async () => {
    const { ctx, registered } = makeHarness()
    const spawnDetached = vi.fn()
    const bridge = { requestTool: vi.fn(), hasConnection: () => false } as unknown as BridgeServer
    registerBrowserTools(ctx, bridge, {
      ...OPTIONS,
      openPagesForUser: false,
      launcher: { platform: 'linux', env: {}, exists: () => true, spawnDetached },
    })
    const tool = registered.find((r) => r.name === 'browser_launch')!
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, { signal: new AbortController().signal })
    expect(spawnDetached).not.toHaveBeenCalled()
    expect(String((result as { text: string }).text)).toContain('switched off')
  })

  it('exposes optional frame routing on frame-local tools only', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const byName = new Map(registered.map((entry) => [entry.name, entry.definition]))
    for (const name of ['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_get_text', 'browser_wait', 'browser_describe_image']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: { type?: unknown } } }
      expect(params.properties.frame?.type).toBe('number')
    }
    for (const name of ['browser_snapshot', 'browser_navigate', 'browser_open_tab', 'browser_list_tabs', 'browser_follow_tab', 'browser_close_tab', 'browser_back', 'browser_forward', 'browser_reload']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: unknown } }
      expect(params.properties.frame).toBeUndefined()
    }
  })

  it('opens the extensions page when the extension is not installed anywhere', async () => {
    // 这个功能存在就是为了消除那条死路：用户被告知去安装扩展，而其实离那个能
    // 完成这件事的页面只有一次点击之遥。
    const { ctx, registered } = makeHarness()
    const onInstallNeeded = vi.fn()
    const bridge = { requestTool: vi.fn(), hasConnection: () => false } as unknown as BridgeServer
    registerBrowserTools(ctx, bridge, {
      ...OPTIONS,
      onInstallNeeded,
      launcher: {
        platform: 'linux',
        env: {},
        exists: (path) => path === '/usr/bin/google-chrome',
        executableOfDefaultBrowser: () => '/usr/bin/google-chrome',
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
        extensionInstall: () => ({ installed: [], checked: ['chrome (Default)'] }),
        // 什么都不启动：浏览器已经在跑了，所以只把页面打开。
        spawnDetached: vi.fn(),
      },
    })
    const tool = registered.find((r) => r.name === 'browser_launch')!
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, { signal: new AbortController().signal })
    expect(onInstallNeeded).toHaveBeenCalledWith('chrome://extensions/')
    expect(String((result as { text: string }).text)).toContain('chrome://extensions/')
  })

  it('does not open any page while the user has page-opening switched off', async () => {
    const { ctx, registered } = makeHarness()
    const onInstallNeeded = vi.fn()
    const bridge = { requestTool: vi.fn(), hasConnection: () => false } as unknown as BridgeServer
    registerBrowserTools(ctx, bridge, {
      ...OPTIONS,
      openPagesForUser: false,
      onInstallNeeded,
      launcher: { platform: 'linux', env: {}, exists: () => true, extensionInstall: () => ({ installed: [], checked: [] }) },
    })
    const tool = registered.find((r) => r.name === 'browser_launch')!
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, { signal: new AbortController().signal })
    expect(onInstallNeeded).not.toHaveBeenCalled()
  })

  it('falls back to a no-text payload when the extension returns non-text', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce(null)
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const tool = registered.find((r) => r.name === 'browser_wait')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(result).toEqual({ text: expect.stringContaining('no text') })
  })

  it('renders the canonical result as one text block', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, openPagesForUser: true })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown }
    expect(output.render({}, { text: 'hello' })).toEqual([{ type: 'text', text: 'hello' }])
  })
})
