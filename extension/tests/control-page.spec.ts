// @vitest-environment jsdom

/**
 * 侧边面板的测试：它的纯函数辅助、Markdown 路径，以及
 * 渲染出来的对话。
 *
 * 面板的职责就是展示说了什么，所以这里的断言都围着
 * 对话记录转：你的话以你的话的样子出现，模型的回复
 * 以渲染并流式输出的形态出现，一次工具运行是一行安静的文字，而页面或模型
 * 里的任何东西都不能变成标记。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { flushAnimationFrames } from './setup.ts'
import type { ApprovalRequest } from '../src/security/approval.ts'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'
import type { ActivityEntry, ControlRequest, ControlState, TimelineEntry } from '../src/settings.ts'
import { SETTINGS_DEFAULTS } from '../src/settings.ts'
import { controlCopy } from '../control/strings.ts'
import { renderMarkdown, stabilizeStreamingMarkdown } from '../control/markdown.ts'
import {
  App,
  approvalDecisions,
  assistantTextFromEvent,
  bridgeStateText,
  controlledTabText,
  isUserAuthoredMessage,
  mergeActivity,
  mergeApprovals,
  stateText,
  textFromBlocks,
  timelineFromState,
  toolLabel,
  type ControlPort,
} from '../control/main.ts'
import { classifyInput } from '../control/command.ts'

/** 一个 port stub，记下页面发了什么，并像 worker 一样作答。 */
class StubPort {
  readonly sent: ControlRequest[] = []
  readonly calls: ControlRequest[] = []
  connected = true
  /** 把它设上，下一次应答就会失败，好走到错误路径。 */
  failure: string | null = null

  asControlPort(): ControlPort {
    return this as unknown as ControlPort
  }

  connect(): void {}
  dispose(): void {}

  post(message: ControlRequest): boolean {
    this.sent.push(message)
    return true
  }

  call(message: ControlRequest): Promise<{ sessionId?: string }> {
    this.calls.push(message)
    if (this.failure !== null) return Promise.reject(new Error(this.failure))
    // `session.create` 是唯一用标识符作答的调用。
    return Promise.resolve(message.type === 'session.create' ? { sessionId: 'session-created' } : {})
  }
}

function tab(overrides: Partial<TabAffinityState> = {}): TabAffinityState {
  return { revision: 1, status: 'following', controlled: null, active: null, pinned: false, ...overrides }
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'a1',
    kind: 'action',
    action: 'browser_click',
    summary: '点击元素 [3]',
    origins: ['https://example.com'],
    canTrust: true,
    ...overrides,
  }
}

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return { id: 's1', kind: 'step', text: '点击元素 [3]', tool: 'browser_click', state: 'done', at: 1_000, ...overrides }
}

function state(overrides: Partial<ControlState> = {}): ControlState {
  return {
    enabled: true,
    bridge: 'connected',
    caps: { snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    affinity: tab(),
    approvals: [],
    settings: { ...SETTINGS_DEFAULTS },
    sessionTrustedOrigins: [],
    activity: [],
    session: { id: 'session-1', turn: 'idle', pendingPrompt: false },
    timeline: [],
    // 一次允许打开页面的已完成握手，跟插件的
    // 默认值一致。关心的测试自己传 policy。
    policy: { openPagesForUser: true },
    replaced: false,
    // 除非某个测试主动要求，否则不会有 follow 失败。
    followError: null,
    ...overrides,
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

/**
 * 面板的源码目录。
 *
 * 从这个文件推出来，不用 `process.cwd()`：后者只有在 runner 恰好
 * 通过 `pnpm --filter` 调用时才是包目录。从仓库根目录跑，cwd 会让
 * 这些读取以一个 ENOENT 失败，而那个路径完全在仓库之外。
 */
const CONTROL_DIR = resolve(import.meta.dirname, '..', 'control')

describe('formatting helpers', () => {
  it('has complete bridge wording for all four states', () => {
    const copy = controlCopy('zh')
    for (const value of ['connecting', 'connected', 'reconnecting', 'stopped'] as const) {
      expect(bridgeStateText(value, copy)).not.toBe('')
    }
    expect(bridgeStateText('connected', copy)).toBe('已连接')
    expect(bridgeStateText('connected', controlCopy('en'))).toBe('Connected')
  })

  it('names the controlled page and falls back when there is none', () => {
    const copy = controlCopy('zh')
    expect(controlledTabText(tab(), copy)).toBe(copy.tab.none)
    expect(controlledTabText(tab({ controlled: { tabId: 1, windowId: 1, title: 'Example', url: 'https://example.com' } }), copy)).toBe('Example')
    expect(controlledTabText(tab({ controlled: { tabId: 1, windowId: 1, title: '  ', url: 'https://example.com/x' } }), copy)).toBe('https://example.com/x')
  })

  it('words every step state in both languages', () => {
    for (const value of ['pending', 'running', 'done', 'failed', 'denied', 'cancelled'] as const) {
      expect(stateText(value, 'zh')).not.toBe('')
      expect(stateText(value, 'en')).not.toBe('')
    }
    expect(stateText('done', 'zh')).toBe('已完成')
  })

  it('labels a tool without the noisy prefix', () => {
    const copy = controlCopy('zh')
    expect(toolLabel('browser_snapshot', copy)).toBe('snapshot')
    expect(toolLabel('browser_close_tab', copy)).toBe('close tab')
    expect(toolLabel(undefined, copy)).toBe(copy.timeline.tool)
  })
})

describe('approvalDecisions', () => {
  it('offers deny and allow-once first for every request', () => {
    expect(approvalDecisions(approval()).slice(0, 2)).toEqual(['deny', 'allow-once'])
  })

  it('adds a standing read grant only for reads', () => {
    expect(approvalDecisions(approval({ kind: 'read' }))).toContain('always-allow-reads')
    expect(approvalDecisions(approval({ kind: 'action' }))).not.toContain('always-allow-reads')
  })

  it('adds session trust only for one trustable origin', () => {
    expect(approvalDecisions(approval())).toContain('trust-session')
    expect(approvalDecisions(approval({ canTrust: false }))).not.toContain('trust-session')
    expect(approvalDecisions(approval({ origins: ['https://a.test', 'https://b.test'] }))).not.toContain('trust-session')
  })
})

describe('mergeActivity', () => {
  const first: ActivityEntry = { id: '1', kind: 'tool', name: 'browser_click', summary: 'one', origin: null, state: 'running', at: 1 }

  it('prepends newest first and replaces a row by id', () => {
    const done = { ...first, state: 'done' as const }
    expect(mergeActivity([first], done)).toEqual([done])
    const second: ActivityEntry = { ...first, id: '2', summary: 'two' }
    expect(mergeActivity([first], second).map((row) => row.id)).toEqual(['2', '1'])
  })

  it('caps the list and honors an explicit limit', () => {
    let rows: ActivityEntry[] = []
    for (let index = 0; index < 10; index += 1) rows = mergeActivity(rows, { ...first, id: String(index) }, 3)
    expect(rows.map((row) => row.id)).toEqual(['9', '8', '7'])
    expect(mergeActivity(rows, first, 0)).toEqual([])
  })
})

describe('mergeApprovals', () => {
  it('keeps one entry per id and replaces the set on a snapshot', () => {
    const live = mergeApprovals(new Map(), [approval()])
    expect(live.size).toBe(1)
    const pushed = mergeApprovals(live, [approval({ id: 'a2' })])
    expect([...pushed.keys()]).toEqual(['a1', 'a2'])
    expect(mergeApprovals(pushed, [], { full: true }).size).toBe(0)
  })

  it('never revives an id the user already answered', () => {
    const answered = new Set(['a1'])
    expect(mergeApprovals(new Map(), [approval()], { answered }).size).toBe(0)
    expect(mergeApprovals(new Map(), [approval(), approval({ id: 'a9' })], { answered }).size).toBe(1)
  })
})

describe('dsh payload readers', () => {
  it('reads text out of a content-block array', () => {
    expect(textFromBlocks([{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: ' world' }])).toBe('hello world')
    expect(textFromBlocks('nope')).toBe('')
  })

  it('extracts assistant text but ignores a tool-only message', () => {
    expect(assistantTextFromEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'done' }] } },
    })).toBe('done')
    expect(assistantTextFromEvent({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool_use', name: 'browser_click' }] } },
    })).toBeUndefined()
    expect(assistantTextFromEvent({ type: 'tool/call' })).toBeUndefined()
  })

  it('separates a real user turn from an injected reminder', () => {
    expect(isUserAuthoredMessage({ type: 'user/message', data: { message: { source: { kind: 'user' } } } })).toBe(true)
    expect(isUserAuthoredMessage({ type: 'user/message', data: { message: { source: { kind: 'plugin' } } } })).toBe(false)
    expect(isUserAuthoredMessage({ type: 'assistant/message' })).toBe(false)
  })

  it('derives transcript rows from the legacy activity list when needed', () => {
    const legacy = state({
      timeline: [],
      activity: [
        { id: 'b', kind: 'tool', name: 'browser_click', summary: 'second', origin: null, state: 'done', at: 2 },
        { id: 'a', kind: 'tool', name: 'browser_snapshot', summary: 'first', origin: null, state: 'done', at: 1 },
      ],
    })
    expect(timelineFromState(legacy).map((row) => row.id)).toEqual(['a', 'b'])
  })
})

describe('markdown rendering', () => {
  it('renders the markup the model actually sends', () => {
    const html = renderMarkdown('**bold** and `code`\n\n- one\n- two\n\n```js\nconst a = 1\n```')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<pre>')
  })

  it('strips scripts, event handlers, and images', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[click](javascript:alert(3))')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
  })

  it('opens links safely in a new tab', () => {
    const html = renderMarkdown('[docs](https://example.com/x)')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('href="https://example.com/x"')
  })

  it('closes a fence that is still being streamed', () => {
    expect(stabilizeStreamingMarkdown('text\n```js\nconst a = 1')).toBe('text\n```js\nconst a = 1\n```')
    expect(stabilizeStreamingMarkdown('text\n```js\na\n```')).toBe('text\n```js\na\n```')
  })
})

describe('rendered panel', () => {
  function mount(initial: ControlState = state()) {
    const root = document.createElement('div')
    document.body.append(root)
    const port = new StubPort()
    const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
    app.start()
    app.handleMessage({ type: 'state', state: initial })
    return { app, port, root }
  }

  it('agrees with the page it is loaded into about the mount element', () => {
    // 面板曾经在样式表里用 `#root`，在 HTML 里却用 `#control-root`。
    // 什么都没报错：那个元素就是没有高度，它下面的每个
    // 百分比都解析不出来，于是设置面板渲染成一个
    // 矮盒子，下面全是空白。字符串必须和字符串对上。
    const html = readFileSync(join(CONTROL_DIR, 'index.html'), 'utf8')
    const css = readFileSync(join(CONTROL_DIR, 'styles.css'), 'utf8')

    const mountId = /getElementById\('([^']+)'\)/.exec(
      readFileSync(join(CONTROL_DIR, 'main.ts'), 'utf8'),
    )?.[1]
    expect(mountId).toBe('control-root')

    // HTML 必须定义那个 id，样式表必须给它一个高度。
    expect(html).toContain(`id="${mountId}"`)
    expect(new RegExp(`#${mountId}\\s*\\{[^}]*height`).test(css)).toBe(true)
  })

  it('never lets the reading cap exceed the panel it is drawn into', () => {
    // 这个上限是*最大*列宽，但它当时被直接写了进去：一个 360px 宽的面板配上
    // `readWidth` 640，会设成 `--panel-max: 640px`，每个文本列都在 360px 的盒子
    // 里按 640px 宽布局，而对话记录自身的 `overflow-x: hidden` 把
    // 内容从右边缘裁掉。面板渲染出了头部和输入区，中间看起来
    // 却是一片空白 —— jsdom 没有布局，所以只有值断言才能抓住它。
    const { app, root } = mount()
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 360 })

    app.handleMessage({ type: 'state', state: state({ settings: { ...SETTINGS_DEFAULTS, readWidth: 640 } }) })

    expect(document.documentElement.style.getPropertyValue('--panel-max')).toBe('360px')

    // 比上限更宽的面板保留这个上限，而上限依然不会在任何地方取胜。
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 1400 })
    app.handleMessage({ type: 'state', state: state({ settings: { ...SETTINGS_DEFAULTS, readWidth: 640 } }) })
    expect(document.documentElement.style.getPropertyValue('--panel-max')).toBe('640px')
  })

  it('pins both grid axes, so no content can stretch the panel sideways', () => {
    // 那种空白面板的真实形态：`.app` 声明了 `grid-template-rows`，带着
    // 刻意写的 `minmax(0, 1fr)` 保护，却**完全没有 `grid-template-columns`**。隐式的
    // `auto` 列按其项目的 max-content 定尺寸，于是一条长而不可断行的工具摘要
    // 把那一列在 360px 的面板里撑到约 2346px；接着 `body { overflow-x: hidden }`
    // 把内容裁掉，面板就把头部和输入区画在了一片空白之上。
    // jsdom 没有布局引擎，所以只能对声明本身断言这个保护 ——
    // 而列轴恰恰是这里曾经被遗忘过一次的那一个。
    // 先剥掉注释：CSS 注释里合法地可能含有花括号（本文件
    // 自己关于 `body { overflow-x: hidden }` 的那句就是），这会让幼稚的规则匹配
    // 提前结束，使这个测试报告一个其实存在的声明。
    const css = readFileSync(join(CONTROL_DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const selector of ['.app', '.sheet']) {
      const body = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(body, `${selector} rule`).toContain('display: grid')
      expect(body, `${selector} must pin its column`).toContain('grid-template-columns: minmax(0, 1fr)')
      expect(body, `${selector} must pin its row`).toContain('grid-template-rows')
    }
  })

  it('never applies a cap wider than the panel, at every width a user can drag to', () => {
    // 拖动侧边面板是常规操作，而且每次都会重新应用上限，所以要遍历真正
    // 重要的宽度：远窄于上限、恰好等于上限，以及远宽于上限。
    //
    // 两条规则，这一对就是全部约定：当面板至少有
    // 那么宽时，应用的上限是偏好值；否则就是面板宽度。第二条
    // 正是空白面板的来源 —— 上限绝不能超过面板。
    const { app, root } = mount()
    let panelWidth = 0
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => panelWidth })

    for (const readWidth of [320, 640, 1400]) {
      for (const width of [180, 320, 360, 639, 640, 641, 900, 1400, 2560]) {
        panelWidth = width
        app.handleMessage({ type: 'state', state: state({ settings: { ...SETTINGS_DEFAULTS, readWidth } }) })
        const applied = Number.parseFloat(document.documentElement.style.getPropertyValue('--panel-max'))
        expect(Number.isNaN(applied), `readWidth=${readWidth} panel=${width} produced a number`).toBe(false)
        // 空白面板违反的那一条不变量，也是这个测试唯一主张的东西：
        // 上限绝不超过它所画入的面板宽度。这个偏好在宽面板上
        // 还意味着什么，这里并不断言，因为那是设计选择
        // 而不是缺陷。
        expect(applied, `readWidth=${readWidth} panel=${width} must not exceed the panel`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('survives a resize that arrives before any state does', () => {
    // observer 在挂载时、第一次 `state` 推送之前就会触发。它必须退回到
    // 默认上限，而不是写入 `NaNpx` 或让先前的值滞留在那里。
    const { app, root } = mount()
    let panelWidth = 300
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => panelWidth })
    panelWidth = 300
    app.handleMessage({ type: 'state', state: state() })
    const applied = document.documentElement.style.getPropertyValue('--panel-max')
    expect(applied).toBe('300px')
    expect(Number.isNaN(Number.parseFloat(applied))).toBe(false)
  })

  it('anchors the settings overlay to the viewport, not to an ancestor', () => {
    // `absolute` 会把覆盖层的大小绑到它上面的高度链上，而那里
    // 断掉的一环在真面板上打开设置之前都是看不见的。
    // `fixed` 不会被它抓住。
    const css = readFileSync(join(CONTROL_DIR, 'styles.css'), 'utf8')
    for (const selector of ['.scrim', '.sheet']) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(rule, `${selector} rule`).toContain('position: fixed')
      expect(rule).toContain('inset: 0')
    }
  })

  it('renders a conversation and nothing else', () => {
    const { root } = mount()
    // 头部只承载实时状态：面板自己的标题由
    // 浏览器的侧边面板外框绘制。
    expect(root.querySelector('.header__title')).toBeNull()
    expect(root.querySelector('.header .dot')).not.toBeNull()
    expect(root.querySelector('.transcript')).not.toBeNull()
    expect(root.querySelector('.composer__input')).not.toBeNull()
    // 没有摘要卡片，没有教程文字，也完全没有图片。任务列表是
    // 对话记录上方唯一的东西，而且只有在一轮对话已经
    // 宣布了它之后才出现，所以空闲的面板不带它。
    expect(root.querySelector('.summary')).toBeNull()
    expect(root.querySelector('.plan')).toBeNull()
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.textContent).not.toContain('browser_click')
    expect(root.textContent).not.toContain('其余文字交给 AI')
  })

  it('shows your message as a bubble and the reply as text', () => {
    const { root } = mount(state({
      timeline: [
        { id: 'r1', kind: 'request', text: '总结这个页面', state: 'done', at: 1 },
        { id: 'a1', kind: 'assistant', text: '**要点**：这是一个示例页面。', state: 'done', at: 2 },
      ],
    }))
    expect(root.querySelector('.msg--user .msg__bubble')?.textContent).toBe('总结这个页面')
    // 回复按 markdown 渲染，而不是当作标点符号显示。
    expect(root.querySelector('.msg--assistant strong')?.textContent).toBe('要点')
    expect(root.querySelectorAll('.msg')).toHaveLength(2)
  })

  it('shows a tool run as one quiet line with a marker', () => {
    const { root } = mount(state({ timeline: [entry({ text: '点击元素 [3]' })] }))
    const line = root.querySelector('.tool-line')
    expect(line?.textContent).toContain('点击元素 [3]')
    // 状态标记是一个内联 SVG，带着状态 class；面板里
    // 任何地方都没有图片。
    expect(root.querySelector('.tool-line__icon')?.tagName.toLowerCase()).toBe('svg')
    expect(root.querySelector('.tool-line .tool-line__icon')?.getAttribute('class')).toContain('tool-line__icon')
    expect(root.querySelector('.tool-detail')).toBeNull()
  })

  it('expands a tool line to its detail and collapses it again', () => {
    const { root } = mount(state({ timeline: [entry({ id: 'step-1' })] }))
    root.querySelector<HTMLButtonElement>('.tool-line')!.click()
    expect(root.querySelector('.tool-detail')?.textContent).toContain('browser_click')
    root.querySelector<HTMLButtonElement>('.tool-line')!.click()
    expect(root.querySelector('.tool-detail')).toBeNull()
  })

  it('streams the reply, then defers to the durable message', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    app.handleMessage({
      type: 'session.stream',
      event: { sessionId: 'session-1', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text: '正在' } } },
    })
    // 流式重绘被合并为每帧一次，所以 DOM 是在帧上赶上来，
    // 而不是在 delta 上。
    flushAnimationFrames()
    expect(root.querySelector('.msg--streaming .msg__text')?.textContent).toContain('正在')
    expect(root.querySelector('.caret')).not.toBeNull()

    // 持久化的行替换流式的那一行：恰好一条 assistant 消息。
    app.handleMessage({
      type: 'session.event',
      sessionId: 'session-1',
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '**最终答复**' }] } },
      },
    })
    app.handleMessage({
      type: 'state',
      state: state({ timeline: [{ id: 'a1', kind: 'assistant', text: '**最终答复**', state: 'done', at: 3 }] }),
    })
    const replies = [...root.querySelectorAll('.msg--assistant')]
    expect(replies).toHaveLength(1)
    expect(replies[0]?.querySelector('strong')?.textContent).toBe('最终答复')
  })

  it('does not render Markdown while the reply is still streaming', () => {
    // 每个 delta 都渲染 Markdown，会每次都重新解析并重新清理整条回复，
    // 这在回复长度上是二次的：在快速流式输出时面板落后了，
    // 而且再也追不上，所以它看起来像卡死而不是慢。下面这个围栏代码块
    // 正是 Markdown 处理会变成 `pre`/`code` 的东西，因此它在
    // 流式气泡中的缺席，就是那条保证的可观察形态。
    const { app, root } = mount()
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    app.handleMessage({
      type: 'session.stream',
      event: {
        sessionId: 'session-1',
        kind: 'delta',
        payload: { type: 'chunk', chunk: { type: 'text-delta', text: '```js\nconst x = 1\n```\n' } },
      },
    })
    // 第二个 delta，让流式路径运行不止一次。
    app.handleMessage({
      type: 'session.stream',
      event: {
        sessionId: 'session-1',
        kind: 'delta',
        payload: { type: 'chunk', chunk: { type: 'text-delta', text: '**粗体**' } },
      },
    })
    flushAnimationFrames()

    const streaming = root.querySelector('.msg--streaming .msg__text')
    expect(streaming).not.toBeNull()
    // 文本就在那里、可读，完全是模型发来的样子……
    expect(streaming?.textContent).toContain('const x = 1')
    expect(streaming?.textContent).toContain('**粗体**')
    // ……而且未被渲染：流式输出期间完全没有 Markdown 产物。
    expect(streaming?.querySelector('pre')).toBeNull()
    expect(streaming?.querySelector('code')).toBeNull()
    expect(streaming?.querySelector('strong')).toBeNull()
  })

  it('keeps the streaming branch free of any Markdown call', () => {
    // 上面的 DOM 断言证明了今天的行为。这一条守护的是
    // 代码形态，因为那个回归只是一行改动：把 `renderMarkdown` 放回
    // 流式分支，正是当初引入卡死的方式，而它仍然会
    // 通过一个只看可见内容的测试。
    const source = readFileSync(join(CONTROL_DIR, 'main.ts'), 'utf8')
    const body = /private assistantBubbleChildren\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(source)?.[1] ?? ''
    expect(body, 'assistantBubbleChildren source').not.toBe('')

    // 流式分支必须排在前面，而且绝不能调用 renderMarkdown。
    const streamingBranch = /if \(streaming\) \{([\s\S]*?)\}/.exec(body)?.[1] ?? ''
    expect(streamingBranch, 'streaming branch').toContain('text')
    expect(streamingBranch, 'streaming branch').not.toContain('renderMarkdown')

    // Markdown 仍然会被渲染 —— 为已完成的回复。
    expect(body).toContain('renderMarkdown')
  })

  it('parses Markdown once, when the reply is finished', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    for (const text of ['一段', '回答']) {
      app.handleMessage({
        type: 'session.stream',
        event: { sessionId: 'session-1', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text } } },
      })
    }
    flushAnimationFrames()
    // 流式输出期间仍然未被渲染。
    expect(root.querySelector('.msg--streaming strong')).toBeNull()

    // 已完成的回复会被渲染，这是唯一需要 Markdown 的地方。
    app.handleMessage({
      type: 'state',
      state: state({ timeline: [{ id: 'a1', kind: 'assistant', text: '**完成**', state: 'done', at: 3 }] }),
    })
    expect(root.querySelector('.msg--assistant strong')?.textContent).toBe('完成')
  })

  it('treats a durable running reply as streaming, not as finished', () => {
    // 真实应用的形态，也是更早的测试漏掉的那一个：worker 在第一个 delta 时就创建
    // 一条持久的 `assistant` 行，并让它在整轮对话中保持 `running`，
    // 而那一行是通过 `state.timeline` 到达的。只把合成行当作流式
    // 意味着 `.msg--streaming` 从未存在过，于是每一帧都重建整个对话记录，
    // 并为一个仍在书写中的回复渲染 Markdown —— 正是流式模式
    // 存在所要避免的那条二次路径。
    const { app, root } = mount(state({
      timeline: [{ id: 'a-live', kind: 'assistant', text: '```js\nconst x = 1\n```', state: 'running', at: 1 }],
    }))
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    app.handleMessage({
      type: 'session.stream',
      event: {
        sessionId: 'session-1',
        kind: 'delta',
        payload: { type: 'chunk', chunk: { type: 'text-delta', text: '\nconst y = 2' } },
      },
    })
    flushAnimationFrames()

    // 那条 running 行就是流式目标，它被渲染为纯文本……
    const streaming = root.querySelector('[data-streaming] .msg__text')
    expect(streaming).not.toBeNull()
    expect(streaming?.textContent).toContain('const x = 1')
    // ……而不是 Markdown，也不是重复的一行。
    expect(streaming?.querySelector('pre')).toBeNull()
    expect(root.querySelectorAll('.msg--assistant')).toHaveLength(1)
  })

  it('renders the reply as Markdown once the turn ends', () => {
    // 同一个约定的另一半：流式是纯文本，已完成的回复不是。
    const { app, root } = mount(state({
      timeline: [{ id: 'a-live', kind: 'assistant', text: '**粗体**', state: 'running', at: 1 }],
    }))
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    expect(root.querySelector('[data-streaming]')).not.toBeNull()

    // `turn/end` 让这一行尘埃落定，所以它必须不再是流式目标。
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/end' } })
    app.handleMessage({
      type: 'state',
      state: state({ timeline: [{ id: 'a-live', kind: 'assistant', text: '**粗体**', state: 'done', at: 1 }] }),
    })
    expect(root.querySelector('[data-streaming]')).toBeNull()
    expect(root.querySelector('.msg--assistant strong')?.textContent).toBe('粗体')
  })

  it('keeps a cache in the Markdown path, so a rebuild does not re-parse', () => {
    // 重建对话记录时会为屏幕上每一条回复重新渲染 Markdown，所以一个无关的
    // 更新（一次工具步骤、一个审批、展开一行）就要付出解析整段
    // 对话的代价。这个映射是纯的，所以 `renderMarkdown` 复用自己的结果。
    //
    // 缓存无法通过返回值观察到 —— 两种情况下渲染都是确定性的 ——
    // 所以这里断言的是代码形态，和流式分支那条
    // 守卫一样。没有这次查找，审计测到的代价就会直接回来。
    const source = readFileSync(join(CONTROL_DIR, 'markdown.ts'), 'utf8')
    const body = /export function renderMarkdown\([\s\S]*?\n\}/.exec(source)?.[0] ?? ''
    expect(body, 'renderMarkdown source').not.toBe('')
    expect(body, 'consults the cache').toContain('rendered.get(text)')
    expect(body, 'fills the cache').toContain('rendered.set(text,')
    // 有界：在长会话中不设界的缓存就是一次泄漏。
    expect(source, 'cache is bounded').toMatch(/CACHE_LIMIT\s*=\s*\d+/)
    expect(body, 'evicts').toContain('rendered.delete(')
  })

  it('still sanitizes every render, including a cache miss', () => {
    // 缓存位于清理器之前，所以这证明了它是缓存而不是
    // 绕过：恶意字符串绝不能存活，无论它之前是否出现过。
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>'
    const first = renderMarkdown(hostile)
    const second = renderMarkdown(hostile)
    expect(first).not.toContain('<script')
    expect(first).not.toContain('onerror')
    expect(first).not.toContain('<img')
    expect(second).toBe(first)
  })

  it('repaints at most once per frame no matter how many deltas arrive', () => {    // 合并才是重点：一串 delta 绝不能产生一串工作。
    // 元素的创建能显示重绘的发生，所以一帧内落下的十个 delta
    // 应该只花一次小重绘，而不是十次。
    const created = vi.spyOn(document, 'createElement')
    try {
      const { app, root } = mount()
      app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
      flushAnimationFrames()
      created.mockClear()

      // 一帧份量的 delta —— 远多于一次显示刷新会送来的数量。
      for (const text of ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']) {
        app.handleMessage({
          type: 'session.stream',
          event: { sessionId: 'session-1', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text } } },
        })
      }
      // 还没有帧运行过，所以还没有发生重绘。
      expect(created).not.toHaveBeenCalled()

      flushAnimationFrames()
      // 十个 delta，一次重绘。元素的确切数量是实现细节；
      // 被锁定下来的保证是：它是一次小重绘，而不是十次。
      expect(created.mock.calls.length).toBeGreaterThan(0)
      expect(created.mock.calls.length).toBeLessThan(10)
      expect(root.querySelector('.msg--streaming .msg__text')?.textContent).toContain('十')
    } finally {
      created.mockRestore()
    }
  })

  it('ignores a stream that belongs to another session', () => {
    const { app, root } = mount()
    app.handleMessage({
      type: 'session.stream',
      event: { sessionId: 'other', kind: 'delta', payload: { type: 'chunk', chunk: { type: 'text-delta', text: '泄漏' } } },
    })
    expect(root.textContent).not.toContain('泄漏')
  })

  it('never turns page or model text into markup', () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    const { app, root } = mount(state({
      timeline: [entry({ text: payload })],
      affinity: tab({ controlled: { tabId: 1, windowId: 1, title: payload, url: 'https://evil.test' } }),
    }))
    app.handleMessage({ type: 'approval.request', request: approval({ summary: payload, origins: [payload] }) })
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.querySelectorAll('script')).toHaveLength(0)
    expect(root.textContent).toContain(payload)
  })

  it('answers an approval through the port and drops the card', () => {
    const { app, port, root } = mount()
    app.handleMessage({ type: 'approval.request', request: approval() })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.approval__actions button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['不允许', '允许', '这个网站以后不用问'])
    buttons[1]!.click()
    expect(port.sent).toContainEqual({ type: 'approval.respond', id: 'a1', decision: 'allow-once' })
    expect(root.querySelector('.approval')).toBeNull()
  })

  it('offers the tab handoff choice with the live revision', () => {
    const { app, port, root } = mount()
    app.handleMessage({ type: 'state', state: state({ affinity: tab({ revision: 7, status: 'handoff' }) }) })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.notice__actions button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['留在原页面', '跟过去', '留在这里，不再问'])
    buttons[1]!.click()
    expect(port.sent).toContainEqual({ type: 'affinity.respond', revision: 7, decision: 'follow' })
  })

  it('keeps settings behind the gear, over the conversation', () => {
    const { root } = mount()
    expect(root.querySelector('.sheet')).toBeNull()
    const gear = root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!
    gear.click()
    expect(root.querySelector('.sheet')).not.toBeNull()
    expect(root.querySelector('.sheet__title')?.textContent).toBe('更改设置')
    // 对话记录仍然挂载在下面。
    expect(root.querySelector('.transcript')).not.toBeNull()
    // 只留下用户要求保留的东西。信任列表、自动连接
    // 开关、面板宽度控件，整个连接区块都
    // 不见了：它们要么是这条路径已经回答过的问题，要么是
    // 面板兑现不了的承诺。
    for (const dead of ['永久信任', '临时信任', '自动连接', '固定面板宽度', '桥接地址', '桥接 token', '保存']) {
      expect(root.textContent).not.toContain(dead)
    }
    // 剩下的每个控件都是个选择：两个开关、四个下拉（共享、
    // 对话、标签页切换、图片识别），没一个需要
    // 费心的文本框。图片调用发到哪儿属于部署配置；向
    // 用户要端点、model id 和密钥，就是三件杂务，不是选择。
    expect(root.querySelectorAll('.sheet .switch input')).toHaveLength(2)
    expect(root.querySelectorAll('.sheet .select')).toHaveLength(4)
    expect(root.querySelectorAll('.sheet input[type="text"], .sheet input[type="password"]')).toHaveLength(0)
    root.querySelector<HTMLButtonElement>('.sheet [aria-label="关闭"]')!.click()
    expect(root.querySelector('.sheet')).toBeNull()
  })

  it('offers no control that the browser cannot honour', () => {
    // 侧边面板的宽度由 Chrome 拖出来并记住；扩展
    // 读不到、设不了、也锁不住它，所以给一个「固定宽度」开关就是个
    // 面板兑现不了的承诺。
    const { root } = mount()
    expect(root.querySelectorAll('[aria-pressed]')).toHaveLength(0)
    expect(root.textContent).not.toContain('固定')
  })

  it('opens with an empty composer whose hint is short and only a placeholder', () => {
    // 这个提示是个 attribute，绝不是值：输入框打开时里面
    // 不能已经有文字。现在它也只是个短标签——没有命令示例。
    const { root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    expect(input.value).toBe('')
    expect(input.getAttribute('placeholder')).toBe('输入要做什么')
    expect(input.textContent).toBe('')
    expect(root.textContent).not.toContain('browser_click')
  })

  it('keeps the composer empty across a repaint', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'state', state: state({ activity: [] }) })
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    expect(input.value).toBe('')
    expect(root.textContent).not.toContain('browser_click')
  })

  it('shows the formula while an @ directive is being typed, and its error when wrong', () => {
    const { root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    const type = (value: string): void => {
      input.value = value
      input.dispatchEvent(new Event('input'))
    }

    // 什么都没输入：这一行保持空着，正合用户心意。
    expect(root.querySelector('.composer__meta')?.textContent).toBe('')
    // 只打了一半的指令只显示公式，不抱怨。
    type('@o')
    expect(root.querySelector('.composer__hint')?.textContent).toContain('@open')
    // 公式错了会报出原因，而不是默默变成普通文本。
    type('@open nonsense')
    expect(root.querySelector('.composer__error')?.textContent).toContain('网址')
    // 正确的公式就不再抱怨。
    type('@open https://example.com')
    expect(root.querySelector('.composer__error')).toBeNull()
    expect(root.querySelector('.composer__hint')?.textContent).toContain('@open')
  })

  it('runs an @open directive through the background, not the model', async () => {
    const { port, root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = '@open https://store.steampowered.com pace=slow pin=off'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await vi.waitFor(() => { expect(port.calls).toHaveLength(1) })
    expect(port.calls[0]).toMatchObject({
      type: 'open.run',
      url: 'https://store.steampowered.com/',
      pace: 'slow',
      pin: false,
    })
    // 关键就在这里：别去要求模型做这件事。
    expect(port.calls.some((call) => call.type === 'session.prompt')).toBe(false)
  })

  it('opens the approval card by saying what is being asked', () => {
    // 这张卡片以前以工具自己的摘要（"点击元素 [3]"）开头，那
    // 读起来像机器输出：用户还得自己琢磨这居然是个
    // 提问。现在第一行就把问题问出来。
    const { app, root } = mount()
    app.handleMessage({ type: 'approval.request', request: approval({ kind: 'read' }) })
    expect(root.querySelector('.approval__ask')?.textContent).toBe('AI 想读取这个页面')

    app.handleMessage({ type: 'approval.request', request: approval({ id: 'a2', kind: 'action' }) })
    const asks = [...root.querySelectorAll('.approval__ask')].map((node) => node.textContent)
    expect(asks).toContain('AI 想操作这个页面')
  })

  it('offers buttons that read as allowing or refusing', () => {
    const { app, root } = mount()
    app.handleMessage({ type: 'approval.request', request: approval() })
    const labels = [...root.querySelectorAll<HTMLButtonElement>('.approval__actions button')]
      .map((button) => button.textContent)
    // "允许" 必须出现：用户正在决定要不要许可某件事，而
    // 一组只有 拒绝/仅这一次 的按钮永远说不出这一点。
    expect(labels.some((label) => label?.includes('允许'))).toBe(true)
    expect(labels).toContain('不允许')
  })

  it('runs a typed browser command without asking the model', async () => {
    const { port, root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = 'click index=3'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => { expect(port.calls).toHaveLength(1) })
    expect(port.calls[0]).toMatchObject({ type: 'command.run', name: 'browser_click', args: { index: 3 } })
    expect(port.calls.some((call) => call.type === 'session.prompt')).toBe(false)
  })

  it('forwards natural language and creates the session once', async () => {
    const { port, root } = mount(state({ session: { id: null, turn: 'idle', pendingPrompt: false } }))
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = '总结这个页面'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => {
      expect(port.calls.some((call) => call.type === 'session.prompt')).toBe(true)
    }, { timeout: 2_000 })
    expect(port.calls[0]?.type).toBe('session.create')
    expect(port.calls[1]).toMatchObject({ type: 'session.prompt', text: '总结这个页面' })
  })

  it('clears the composer input once the message is on its way', async () => {
    // 草稿在 `submit()` 的 promise 里清掉了，textarea 却没被碰过：
    // 回合边界的局部重绘（`refreshForTurn`）换了头部、
    // 对话记录和发送按钮，却从没碰过 textarea。于是框里留着
    // 刚刚发出去的那句话，看起来就像什么都没发生——
    // 再按一次 Enter 就把它又发一遍。这个过期值之所以对测试套件
    // 不可见，只是因为没有任何断言盯着它；读者得手动删掉。
    const { root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = '总结这个页面'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await vi.waitFor(() => {
      expect(root.querySelector<HTMLTextAreaElement>('.composer__input')?.value, '发给模型的输入框必须清空').toBe('')
    })
    expect(root.querySelector<HTMLTextAreaElement>('.composer__input')?.value, '发送后不残留原文').not.toContain('总结这个页面')
    // 输入框留在原地，空着、待命：发送不该让读者丢掉 composer。
    expect(document.querySelectorAll('.composer__input')).toHaveLength(1)
  })

  it('clears the composer input after a typed @open directive too', async () => {
    // 同样的漏洞也在两条不走模型的路径上（`@open` 和手动敲的
    // 命令）。它们同样在 promise 里清 `this.draft`，所以三处都得覆盖。
    const { root } = mount()
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = '@open https://example.com'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await vi.waitFor(() => {
      expect(root.querySelector<HTMLTextAreaElement>('.composer__input')?.value).toBe('')
    })
  })

  it('reports a failed command inline and keeps the text for correction', async () => {
    const { app, port, root } = mount()
    port.failure = '拒绝执行'
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.value = 'browser_close_tab tabId=9'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => { expect(root.querySelector('.composer__meta')?.textContent).toContain('拒绝执行') })
    expect(root.querySelector<HTMLTextAreaElement>('.composer__input')?.value).toBe('browser_close_tab tabId=9')
    app.dispose()
  })

  it('swaps the send button for a stop control while a turn runs', () => {
    const { app, root } = mount()
    expect(root.querySelector<HTMLButtonElement>('.composer__box button')?.getAttribute('aria-label')).toBe('发送')
    app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })
    expect(root.querySelector<HTMLButtonElement>('.composer__box button')?.getAttribute('aria-label')).toBe('停止')
  })

  it('writes each settings control through a settings update', () => {
    const { root, port } = mount()
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const select = root.querySelector<HTMLSelectElement>('.select')!
    // 这一行原先选的是 `'off'`；那一档已经删掉了（它号称"页面内容不出浏览器"，
    // 但出厂即开的 unrestricted 会把它盖成 `'auto'`，所以它一档都不生效）。
    // 现在下拉只有两档，这里选「每次询问」。
    select.value = 'ask'
    select.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { sharePageContent: 'ask' },
    }))
    // 两个开关：自动打开和不受限控制。
    const toggles = [...root.querySelectorAll<HTMLInputElement>('.switch input')]
    expect(toggles).toHaveLength(2)
    toggles[0]!.checked = false
    toggles[0]!.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { autoOpenPanel: false },
    }))
    toggles[1]!.checked = true
    toggles[1]!.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { unrestrictedBrowserAccess: true },
    }))
    // 标签页切换下拉也会写它的模式。面板里的顺序是共享、
    // 对话、标签页切换——所以索引是 2。
    const tabSwitch = [...root.querySelectorAll<HTMLSelectElement>('.select')][2]!
    tabSwitch.value = 'follow'
    tabSwitch.dispatchEvent(new Event('change'))
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'settings.update',
      settings: { tabSwitch: 'follow' },
    }))
  })

  it('reports the connection state on the first row, not the permission value', () => {
    // 这一行的标签曾经写「桌面端允许 AI 打开网页」，徽章却写「已连接/未连接」，
    // 而且「连上没有」是拿 `policy !== null` 判断的 —— 那问的是「宿主有没有下发
    // policy」，不是「扩展连上没有」。两件事通常同时为真（默认 state 里
    // `bridge: 'connected'` 伴着 `policy` 一起出现），所以旧断言碰巧一直通过：
    // 它传 `policy: {...}` 而连接本来就是 true，于是「已连接」看着是对的，
    // 其实来源是错的字段。现在标签、徽章、说明都只讲连接，判据也换成 `bridge`。
    const { app, root } = mount(state({ policy: null }))
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const firstRow = root.querySelector('.sheet .setting')!
    expect(firstRow.querySelector('.setting__label')?.textContent).toBe('dsh 连接状态')
    // 默认 state 是连上的：徽章说已连接，尽管这一帧根本没有 policy。
    expect(firstRow.querySelector('.badge')?.textContent).toBe('已连接')
    expect(firstRow.querySelector('.setting__help')?.textContent).toContain('要先打开 dsh')

    // 真正的连接断掉时，徽章必须跟着变 —— 哪怕 policy 还在。这是旧逻辑做不到的：
    // 它只看 policy，所以「桌面端还在、socket 掉了」这种状态会被显示成「已连接」。
    app.handleMessage({ type: 'state', state: state({ bridge: 'stopped', policy: { openPagesForUser: true } }) })
    const offRow = root.querySelector('.sheet .setting')!
    expect(offRow.querySelector('.badge')?.textContent).toBe('未连接')
    // 说明要指出"得先打开 dsh"，而不是只说一句"未连接"。
    expect(offRow.querySelector('.setting__help')?.textContent).toContain('要先打开 dsh')
  })

  it('labels the conversation and tab-switch choices by name', () => {
    const { root } = mount()
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')!.click()
    const selects = [...root.querySelectorAll<HTMLSelectElement>('.select')]
    const tabSwitch = selects.find((select) => select.getAttribute('aria-label') === 'AI 跟随网页')!
    expect([...tabSwitch.options].map((option) => option.textContent)).toContain('跟随')
    const conversation = selects.find((select) => select.getAttribute('aria-label') === '对话同步')!
    expect([...conversation.options].map((option) => option.textContent)).toEqual([
      '工作区内新建对话',
      '工作区内上次浏览器对话',
      '全部工作区',
    ])
  })

  it('says why the panel is not following a conversation, instead of just looking empty', () => {
    // 最常见的原因是桌面应用还在跑旧版 bridge，它不
    // 认识 `session.follow`。没有这条提示，绑上了却没在更新和
    // 没东西可显示看起来一模一样。
    const { root } = mount(state({ followError: '桌面端还没加载新版桥接，面板无法跟随对话。重启 dsh 桌面端后重试。' }))
    expect(root.querySelector('.notice')?.textContent).toContain('重启 dsh 桌面端')
  })

  it('shows no such notice when following is fine', () => {
    const { root } = mount()
    expect(root.textContent).not.toContain('无法跟随')
  })

  it('names a rejected connection, instead of leaving it indistinguishable from "not connected"', () => {
    // 手动加载了 `-store` 包、或扩展 id 不在白名单时，桌面端以 4002 关闭握手。原本面板
    // 只会显示「未连接」——和"桌面端没开"完全一样，而这一种恰恰是用户自己能修的。
    const { root } = mount(state({ bridge: 'stopped', bridgeRejection: { code: 4002, reason: 'bad token' } }))
    expect(root.querySelector('.notice')?.textContent).toContain('桌面端拒绝了这次连接')
  })

  it('drops the rejection notice once the connection is up again', () => {
    // 一次成功的连接之后，那条拒绝就不再是当前事实，继续摆着只会误导人。
    const { root } = mount(state({ bridge: 'connected', bridgeRejection: { code: 4002, reason: 'bad token' } }))
    expect(root.textContent).not.toContain('桌面端拒绝了这次连接')
  })

  it('says another browser took the connection and offers to take it back', () => {
    // 被替换掉的客户端会刻意停止重试，所以一句笼统的「正在重连」
    // 或「重新加载页面」会盖住唯一能解释它的事实。
    const { app, root, port } = mount(state({ replaced: true, bridge: 'stopped' }))
    const notice = root.querySelector('.notice--warning')
    expect(notice?.textContent).toContain('另一个浏览器窗口')

    const button = notice?.querySelector<HTMLButtonElement>('.notice__action')
    expect(button?.textContent).toBe('取回连接')
    button!.click()
    expect(port.sent).toContainEqual({ type: 'bridge.reclaim' })

    // 一旦槽位回来，这条提示就消失。
    app.handleMessage({ type: 'state', state: state({ replaced: false, bridge: 'connected' }) })
    expect(root.querySelector('.notice__action')).toBeNull()
  })

  it('classifies the composer draft the same way the submit path does', () => {
    expect(classifyInput('snapshot')).toMatchObject({ kind: 'command' })
    expect(classifyInput('看看这个页面')).toMatchObject({ kind: 'prompt' })
  })

})
