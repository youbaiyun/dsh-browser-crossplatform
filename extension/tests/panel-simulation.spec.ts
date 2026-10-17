// @vitest-environment jsdom

/**
 * 模拟：一边流式输出回答一边被人使用，面板还撑得住吗？
 *
 * 那些单元 spec 只回答一句「这样渲染对不对」。这一个像桌面应用那样驱动面板
 * ——回答按增量到达、每 50 ms 一次完整状态推送、工具步骤、一个审批请求，还有一个人
 * 全程不停打字——并检查这种负载下会悄悄坏掉的三件事：
 *
 *   1. 对话的两侧都留在屏幕上（你的提示和那条回答）；
 *   2. 控件保持可交互：每一次真实点击仍然产生它该产生的消息；
 *   3. 输入框一直可用：焦点挺过一次重绘、键入的字符真的落到位，草稿也没被吃掉。
 *
 * 有两点让它比乍一看更严格，因为这两点都曾是同一个文件早期草稿里的错误：
 *
 *   - **绝不重新施加焦点。** 真实浏览器在被聚焦的元素被移除时会把焦点移到
 *     `document.body`，而重建路径会移除那个 textarea。早期草稿在每次推送后重新
 *     聚焦，而那恰恰是它本该检测的症状：焦点丢了，就是「打字突然不工作了」。
 *     在这里，面板对焦点做了什么就任它怎样，然后再去观察。
 *   - **键入要打到当前真正持有焦点的元素上。** 字符派发到实际持有焦点的元素，
 *     而不是某个过期的引用，所以文本会像真人遇到的那样丢掉。
 *
 * 它跑 100 轮并打印每一轮的结果，因为五轮才出现一次的间歇性故障，正是单跑
 * 一遍会报成成功的那类问题。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlRequest, ControlState, TimelineEntry } from '../src/settings.ts'
import { SETTINGS_DEFAULTS } from '../src/settings.ts'
import { flushAnimationFrames } from './setup.ts'
import { App, type ControlPort } from '../control/main.ts'
import { controlCopy } from '../control/strings.ts'

const ROUNDS = 100
const TICKS_PER_ROUND = 12

class StubPort {
  readonly sent: ControlRequest[] = []
  readonly calls: ControlRequest[] = []
  connected = true
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
    return Promise.resolve(message.type === 'session.create' ? { sessionId: 'created' } : {})
  }
}

function state(overrides: Partial<ControlState> = {}): ControlState {
  return {
    enabled: true,
    bridge: 'connected',
    caps: { snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    affinity: { revision: 1, status: 'following', controlled: null, active: null, pinned: false },
    approvals: [],
    settings: { ...SETTINGS_DEFAULTS },
    sessionTrustedOrigins: [],
    activity: [],
    session: { id: 'session-1', turn: 'idle', pendingPrompt: false },
    timeline: [],
    policy: { openPagesForUser: true },
    replaced: false,
    followError: null,
    ...overrides,
  }
}

/**
 * 让焦点在一次重建前后的表现像真实浏览器。
 *
 * 浏览器会把焦点从已从文档中移除的元素上移走；jsdom 却让
 * `document.activeElement` 继续指向那个已脱离的节点，把故障藏了起来。这个测试检查
 * `document.contains`，而不是查它在不在 `body` 里：这套测试装置里，挂载元素本身
 * 就是个已脱离的节点，所以用 `body` 查会把每个健康的元素都判成「已移除」，
 * 凭空造出正在被测量的那个故障。
 */
function settleFocusLikeABrowser(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && !document.contains(active)) {
    active.blur()
  }
}

/** 像按键一样，输入到当前持有焦点的元素里。 */
function typeWhereFocusIs(text: string): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLTextAreaElement) && !(active instanceof HTMLInputElement)) return false
  active.value = active.value + text
  active.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

interface RoundResult {
  round: number
  userVisible: boolean
  replyVisible: boolean
  expandWorked: boolean
  approvalWorked: boolean
  focusLost: number
  typedLost: number
  draftKept: boolean
}

describe(`panel simulation (${ROUNDS} rounds)`, () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it('stays usable while a reply streams, every round', async () => {
    const results: RoundResult[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const root = document.createElement('div')
      document.body.append(root)
      const port = new StubPort()
      const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
      app.start()
      app.handleMessage({ type: 'state', state: state() })

      const prompt = `第${round + 1}轮提问`

      // --- 人把提示输入到真实的输入框里 -----------------------
      const first = root.querySelector<HTMLTextAreaElement>('.composer__input')
      expect(first, 'composer input').not.toBeNull()
      first!.focus()
      first!.value = prompt
      first!.dispatchEvent(new Event('input', { bubbles: true }))

      app.handleMessage({ type: 'session.event', sessionId: 'session-1', event: { type: 'turn/start' } })

      const timeline = (reply: string): TimelineEntry[] => [
        { id: 'user-1', kind: 'request', text: prompt, state: 'done', at: 900 },
        { id: 'a-1', kind: 'assistant', text: reply, state: 'running', at: 1_100 },
        { id: 'tool-1', kind: 'step', text: '点击元素 [3]', tool: 'browser_click', state: 'done', at: 1_200 },
      ]

      let replySoFar = ''
      let focusLost = 0
      let typedLost = 0

      for (let tick = 0; tick < TICKS_PER_ROUND; tick++) {
        replySoFar += `段落${tick} `

        // 一行长期存在的 running 行，外加一个 delta，完全按 worker 发布它们的样子。
        app.handleMessage({
          type: 'state',
          state: state({
            session: { id: 'session-1', turn: 'running', pendingPrompt: false },
            timeline: timeline(replySoFar),
          }),
        })
        app.handleMessage({
          type: 'session.stream',
          event: {
            sessionId: 'session-1',
            kind: 'delta',
            payload: { type: 'chunk', chunk: { type: 'text-delta', text: `段落${tick} ` } },
          },
        })
        flushAnimationFrames()

        // 重绘对焦点做了什么，就让它保持那样。
        settleFocusLikeABrowser()

        // 人继续打字。焦点一丢，这些字符也跟着丢。
        if (!typeWhereFocusIs('字')) {
          focusLost += 1
          typedLost += 1
        }
      }

      // --- 回答仍在屏幕上时的各种交互 -------------------------
      const toolButton = root.querySelector<HTMLButtonElement>('.tool-line')
      const before = toolButton?.getAttribute('aria-expanded')
      toolButton?.click()
      settleFocusLikeABrowser()
      const after = root.querySelector<HTMLButtonElement>('.tool-line')?.getAttribute('aria-expanded')
      const expandWorked = before !== undefined && after !== undefined && before !== after

      // 一个在回答中途到达的审批，用对真实标签的一次真实点击来回答。
      app.handleMessage({
        type: 'state',
        state: state({
          session: { id: 'session-1', turn: 'running', pendingPrompt: false },
          timeline: [
            { id: 'user-1', kind: 'request', text: prompt, state: 'done', at: 900 },
            { id: 'a-1', kind: 'assistant', text: replySoFar, state: 'running', at: 1_100 },
          ],
          approvals: [{
            id: `ap-${round}`,
            kind: 'action',
            action: 'browser_click',
            summary: '点击元素 [3]',
            origins: ['https://example.com'],
            canTrust: true,
          }],
        }),
      })
      const allow = [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => (button.textContent ?? '').trim() === '允许')
      allow?.click()
      const approvalWorked = port.sent.some(
        (message) => message.type === 'approval.respond' && message.id === `ap-${round}`,
      )

      // --- 屏幕上有什么 -------------------------------------------------------
      const text = root.textContent ?? ''
      const liveInput = root.querySelector<HTMLTextAreaElement>('.composer__input')

      results.push({
        round,
        userVisible: text.includes(prompt),
        replyVisible: text.includes('段落11'),
        expandWorked,
        approvalWorked,
        focusLost,
        typedLost,
        draftKept: liveInput !== null && liveInput.value.includes(prompt),
      })
    }

    // --- 报告 ---------------------------------------------------------------------
    const rows = results.map((r) => [
      `#${String(r.round + 1).padStart(2)}`,
      r.userVisible ? ' ok ' : 'FAIL',
      r.replyVisible ? ' ok ' : 'FAIL',
      r.expandWorked ? ' ok ' : 'FAIL',
      r.approvalWorked ? ' ok ' : 'FAIL',
      r.focusLost === 0 ? ' ok ' : ` x${r.focusLost}`,
      r.draftKept ? ' ok ' : 'FAIL',
    ].join('  '))
    // eslint-disable-next-line no-console
    console.log(['rnd  user reply expand appr focus draft', ...rows].join('\n'))

    const clean = results.filter((r) =>
      r.userVisible && r.replyVisible && r.expandWorked && r.approvalWorked && r.focusLost === 0 && r.draftKept,
    ).length
    const focusLossRounds = results.filter((r) => r.focusLost > 0).length
    // eslint-disable-next-line no-console
    console.log(
      `\n${clean}/${ROUNDS} 轮完全正常；${focusLossRounds} 轮出现焦点丢失` +
      `（共 ${results.reduce((sum, r) => sum + r.focusLost, 0)} 次，` +
      `连带丢掉 ${results.reduce((sum, r) => sum + r.typedLost, 0)} 次输入）`,
    )

    expect(results.filter((r) => !r.userVisible), '用户文本消失').toHaveLength(0)
    expect(results.filter((r) => !r.replyVisible), '回复文本消失').toHaveLength(0)
    expect(results.filter((r) => !r.expandWorked), '工具行不可交互').toHaveLength(0)
    expect(results.filter((r) => !r.approvalWorked), '审批按钮无效').toHaveLength(0)
    expect(results.filter((r) => !r.draftKept), '草稿被吃掉').toHaveLength(0)
    // 焦点和按键以前只被这个模拟*报告*，从没被断言——于是这个在文档注释里把焦点称作
    // 「『打字突然不工作了』的含义」的文件，本来会在每轮都丢焦点的情况下通过
    // 100 轮。下面这两条正是它存在的理由所针对的回归；上面打印的计数留着，是为了
    // 失败时有一份可读的信息。
    expect(results.filter((r) => r.focusLost > 0), '焦点丢失').toHaveLength(0)
    expect(results.filter((r) => r.typedLost > 0), '输入丢失').toHaveLength(0)
  }, 180_000)

  it('keeps the composer usable while a prompt is sent and while a run is stopped', async () => {
    // 上面那个 100 轮循环只叠加 `state` 推送，所以看不到同一个 bug 的另一半：
    // `runPrompt`、`runCommand`、`runOpen` 和 `stopRun` 也会调完整的 `render()`，而它
    // 会换掉那个 textarea。于是「发送」拿走了读者正在打字的输入框，读者的
    // *下一句*话在 worker 作答时被丢掉。
    const root = document.createElement('div')
    document.body.append(root)
    const port = new StubPort()
    const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
    app.start()
    app.handleMessage({ type: 'state', state: state() })

    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')
    expect(input, 'composer input').not.toBeNull()
    input!.focus()
    input!.value = '第一条消息'
    input!.dispatchEvent(new Event('input', { bubbles: true }))

    // 像按 Enter 那样把它发出去。
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    settleFocusLikeABrowser()

    const afterSend = root.querySelector<HTMLTextAreaElement>('.composer__input')
    expect(afterSend, 'composer still present after send').not.toBeNull()
    expect(document.activeElement, 'focus kept through send').toBe(afterSend)

    // 在提示的往返还没落定时就敲下一条消息。
    expect(typeWhereFocusIs('第二条'), 'keystrokes land after send').toBe(true)
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    settleFocusLikeABrowser()

    const afterResolve = root.querySelector<HTMLTextAreaElement>('.composer__input')
    expect(afterResolve, 'composer still present after the answer').not.toBeNull()
    expect(document.activeElement, 'focus kept through the answer').toBe(afterResolve)
    expect(afterResolve?.value, 'the second message is still there').toContain('第二条')

    // 停止一次运行同样不得把输入框拿走。
    app.handleMessage({
      type: 'state',
      state: state({ session: { id: 'session-1', turn: 'running', pendingPrompt: false } }),
    })
    const stop = root.querySelector<HTMLButtonElement>('#composer-action')
    expect(stop, 'stop button while running').not.toBeNull()
    stop!.focus()
    stop!.click()
    for (let tick = 0; tick < 4; tick++) await Promise.resolve()
    settleFocusLikeABrowser()
    expect(root.querySelector<HTMLTextAreaElement>('.composer__input'), 'composer after stop').not.toBeNull()
  }, 20_000)
})
