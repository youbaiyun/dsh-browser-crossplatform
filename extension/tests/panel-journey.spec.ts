// @vitest-environment jsdom

/**
 * 一段用户旅程，从开头到结尾，全放在一个测试里。
 *
 * 其他 spec 各自只回答一个问题。这一个走的是一个人真会走的顺序，并检查面板在
 * 每一步都还能用——因为目前找到的故障全出在步骤*之间*：面板单独渲染时好好的，
 * 一旦被调过尺寸就变空白；或者只有提示是被「发送」而不是被「推送」时才丢
 * 焦点。
 *
 * 旅程顺序如下：
 *   1. 面板在窄宽度下打开，此时还没有任何状态
 *   2. 状态到达；桌面端正在一场不是面板发起的对话里作答
 *   3. 阅读者在那段回答流式输出的同时输入自己的消息
 *   4. 他们打开设置，改动其中一项
 *   5. 他们把面板拖宽，再拖窄
 *   6. 他们展开一行工具记录，再往上回滚对话记录
 *   7. 一个审批请求到达并被回答
 *   8. 桌面端结束该回合
 *   9. 阅读者切换对话，再切回来
 *
 * 每一步它都断言两件一个人会注意到的事：内容在屏幕上，控件仍然有响应。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlRequest, ControlState } from '../src/settings.ts'
import { SETTINGS_DEFAULTS } from '../src/settings.ts'
import { flushAnimationFrames } from './setup.ts'
import { App, type ControlPort } from '../control/main.ts'
import { controlCopy } from '../control/strings.ts'

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
    return Promise.resolve(message.type === 'session.create' ? { sessionId: 'panel-session' } : {})
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
    session: { id: null, turn: 'idle', pendingPrompt: false },
    timeline: [],
    policy: { openPagesForUser: true },
    replaced: false,
    followError: null,
    ...overrides,
  }
}

/** 一个人会注意到的事：有内容吗，输入框还能用吗？ */
function visible(root: HTMLElement) {
  const transcript = root.querySelector('.transcript')
  const inner = root.querySelector('.transcript__inner')
  return {
    text: (inner?.textContent ?? '').trim(),
    innerWidth: inner === null ? 0 : Math.round(inner.getBoundingClientRect?.().width ?? 0),
    rows: inner === null ? 0 : inner.children.length,
    composer: root.querySelector('.composer__input') !== null,
    header: root.querySelector('.header') !== null,
    panelMax: document.documentElement.style.getPropertyValue('--panel-max'),
    transcriptWidth: transcript === null ? 0 : Math.round(transcript.getBoundingClientRect?.().width ?? 0),
  }
}

describe('user journey', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it('stays usable through a whole session, including a conversation the panel did not start', async () => {
    // --- 1. 面板在窄宽度下打开，worker 还没说任何话 --------------------
    const root = document.createElement('div')
    document.body.append(root)
    let panelWidth = 360
    Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => panelWidth })
    const port = new StubPort()
    const app = new App(root, 'zh', port.asControlPort(), controlCopy('zh'))
    app.start()

    let v = visible(root)
    expect(v.header, '1. header draws before any state').toBe(true)
    expect(v.composer, '1. composer draws before any state').toBe(true)
    expect(v.panelMax, '1. cap is applied on the first paint').toBe('360px')

    // --- 2. 桌面端正在一场不是面板发起的对话里作答 --------
    const desktopPrompt = '在浏览器对话里发出的指令'
    let reply = ''
    const pushWorking = (turn: 'running' | 'idle', state_?: 'running' | 'done') => {
      app.handleMessage({
        type: 'state',
        state: state({
          session: { id: 'desktop-session', turn, pendingPrompt: false },
          timeline: [
            { id: 'u1', kind: 'request', text: desktopPrompt, state: 'done', at: 1 },
            { id: 'a1', kind: 'assistant', text: reply, state: state_ ?? 'running', at: 2 },
            { id: 't1', kind: 'step', text: 'browser_navigate https://github.com', tool: 'browser_navigate', state: 'done', at: 3 },
          ],
        }),
      })
    }
    for (let tick = 0; tick < 5; tick++) {
      reply += `第${tick}段回答 `
      pushWorking('running')
      flushAnimationFrames()
    }
    v = visible(root)
    expect(v.text, '2. the desktop conversation is on screen').toContain(desktopPrompt)
    expect(v.text, '2. its answer is on screen').toContain('第4段回答')
    expect(v.text, '2. its tool run is on screen').toContain('browser_navigate')
    expect(v.rows, '2. rows exist').toBeGreaterThan(0)
    expect(Number.parseFloat(v.panelMax), '2. cap still within the panel').toBeLessThanOrEqual(panelWidth)

    // --- 3. 阅读者在回答流式输出的同时输入自己的消息 ---------------------
    const input = root.querySelector<HTMLTextAreaElement>('.composer__input')!
    input.focus()
    input.value = '我自己的问题'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.activeElement, '3. the composer holds focus').toBe(input)

    // --- 4. 他们打开设置，改动其中一项 ----------------------------------------
    root.querySelector<HTMLButtonElement>('[aria-label="更改设置"]')?.click()
    expect(root.querySelector('.sheet'), '4. the sheet opens').not.toBeNull()
    const selects = [...root.querySelectorAll<HTMLSelectElement>('.sheet select')]
    expect(selects.length, '4. the sheet has controls').toBeGreaterThan(0)
    const sharing = selects[0]!
    sharing.value = sharing.options[sharing.options.length - 1]!.value
    sharing.dispatchEvent(new Event('change', { bubbles: true }))
    expect(port.sent.some((m) => m.type === 'settings.update'), '4. changing a control sends an update').toBe(true)
    // 一次状态推送不得在阅读者脚下重建整个设置面板。这次推送带的是 worker 所知道的
    // 那份设置——还是本地改动之前的那份——所以第一次推送做一次协调是合理的。
    // 第二次一模一样的推送才必须是空操作，正是这一点让下拉菜单在回答流式输出时保持
    // 展开。
    const sameSettings = state({
      session: { id: 'desktop-session', turn: 'running', pendingPrompt: false },
      settings: { ...SETTINGS_DEFAULTS },
    })
    app.handleMessage({ type: 'state', state: sameSettings })
    const settledRow = root.querySelector('.sheet__body .setting')
    expect(settledRow, '4. the sheet has rows after reconciling').not.toBeNull()
    app.handleMessage({ type: 'state', state: sameSettings })
    expect(root.querySelector('.sheet__body .setting'), '4. an unchanged push keeps the sheet').toBe(settledRow)

    // --- 5. 他们把面板拖宽，再拖窄 -----------------------------------
    for (const width of [640, 900, 320, 180, 360]) {
      panelWidth = width
      // 这次推送必须带上正在进行的对话，否则调尺寸也会把它清掉，后面几步就变成
      // 在测一个空面板，而不是一个被调过尺寸的面板。
      pushWorking('running')
      const applied = Number.parseFloat(document.documentElement.style.getPropertyValue('--panel-max'))
      expect(Number.isNaN(applied), `5. width ${width} produced a number`).toBe(false)
      expect(applied, `5. cap must not exceed the ${width}px panel`).toBeLessThanOrEqual(width)
      expect(visible(root).header, `5. header survives width ${width}`).toBe(true)
      expect(visible(root).composer, `5. composer survives width ${width}`).toBe(true)
    }
    panelWidth = 360

    // --- 6. 他们展开一行工具记录并向上回滚 ----------------------------------
    const toolButton = root.querySelector<HTMLButtonElement>('.tool-line')
    expect(toolButton, '6. there is a tool line to expand').not.toBeNull()
    const before = toolButton!.getAttribute('aria-expanded')
    toolButton!.click()
    expect(root.querySelector('.tool-line')?.getAttribute('aria-expanded'), '6. expanding works').not.toBe(before)
    const transcriptEl = root.querySelector<HTMLElement>('.transcript')!
    transcriptEl.scrollTop = 400

    // --- 7. 一个审批请求到达并被回答 --------------------------------------
    app.handleMessage({
      type: 'state',
      state: state({
        session: { id: 'desktop-session', turn: 'running', pendingPrompt: false },
        approvals: [{
          id: 'ap1', kind: 'read', action: 'browser_get_text', summary: '读取页面文本',
          origins: ['https://example.com'], canTrust: true,
        }],
      }),
    })
    const allow = [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => (b.textContent ?? '').trim() === '允许')
    expect(allow, '7. the approval offers 允许').not.toBeUndefined()
    allow!.click()
    expect(port.sent.some((m) => m.type === 'approval.respond'), '7. answering posts a decision').toBe(true)

    // --- 8. 桌面端结束该回合 --------------------------------------------
    pushWorking('idle', 'done')
    flushAnimationFrames()
    v = visible(root)
    expect(v.text, '8. the finished reply is still on screen').toContain('第4段回答')
    expect(v.composer, '8. composer survived the whole journey').toBe(true)
    expect(root.querySelector<HTMLTextAreaElement>('.composer__input')?.value, '8. the typed draft survived').toBe('我自己的问题')

    // --- 9. 他们切换对话再切回来 -----------------------------------
    app.handleMessage({
      type: 'state',
      state: state({ session: { id: 'other-session', turn: 'idle', pendingPrompt: false }, timeline: [] }),
    })
    flushAnimationFrames()
    v = visible(root)
    expect(v.text, '9. the previous conversation is not painted into the new one').not.toContain('第4段回答')
    expect(v.text, '9. the new conversation is not the old prompt').not.toContain(desktopPrompt)
    expect(v.composer, '9. composer survives the switch').toBe(true)

    app.handleMessage({
      type: 'state',
      state: state({
        session: { id: 'desktop-session', turn: 'idle', pendingPrompt: false },
        timeline: [
          { id: 'u1', kind: 'request', text: desktopPrompt, state: 'done', at: 1 },
          { id: 'a1', kind: 'assistant', text: reply, state: 'done', at: 2 },
        ],
      }),
    })
    flushAnimationFrames()
    expect(visible(root).text, '9. coming back restores the conversation').toContain(desktopPrompt)
    expect(visible(root).composer, '9. composer survives the return').toBe(true)
  }, 30_000)
  it('flips the send button to stop and back on a state push alone', () => {
    // 回合标志既随 `session.event` 到达，也随 `state` 到达。`refreshComposerAction` 过去
    // 只从回合事件那条路径被调用，所以光由 state 引起的转换会让按钮停在上一个回合的
    // 样子——回合已经结束，却还显示停止按钮。
    const root = document.createElement('div')
    document.body.append(root)
    const app = new App(root, 'zh', new StubPort().asControlPort(), controlCopy('zh'))
    app.start()
    app.handleMessage({ type: 'state', state: state() })
    expect(root.querySelector('#composer-action')?.getAttribute('aria-label'), 'idle shows send')
      .toBe(controlCopy('zh').composer.send)

    app.handleMessage({ type: 'state', state: state({ session: { id: 's1', turn: 'running', pendingPrompt: false } }) })
    expect(root.querySelector('#composer-action')?.getAttribute('aria-label'), 'running shows stop')
      .toBe(controlCopy('zh').composer.stop)

    app.handleMessage({ type: 'state', state: state({ session: { id: 's1', turn: 'idle', pendingPrompt: false } }) })
    expect(root.querySelector('#composer-action')?.getAttribute('aria-label'), 'idle shows send again')
      .toBe(controlCopy('zh').composer.send)
  })
})
