// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TabAffinityController,
  isTabAffinityDecision,
  isTabSwitchMode,
  type AffinityTab,
} from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title, url: `https://example.com/${tabId}` }
}

/**
 * 一个绑定到 tab 1、现在看着 `tabId` 的控制器，处于会弹出交接询问的模式。
 *
 * `ask` 已经不是默认值了——用户要求去掉的正是每次切换都弹一次询问——所以针对这个询问
 * 的测试会显式选这个模式。
 */
function switchedTo(tabId: number): TabAffinityController {
  return switchedToIn('ask', tabId)
}

/** 同样的搭建，只是切换模式由调用方指定。 */
function switchedToIn(mode: 'ask' | 'follow' | 'keep', tabId: number): TabAffinityController {
  const affinity = new TabAffinityController()
  affinity.setSwitchMode(mode)
  affinity.observeActive(tab(1))
  affinity.bindInitial(tab(1))
  affinity.observeActive(tab(tabId))
  return affinity
}

describe('TabAffinityController', () => {
  it('binds the first tool target and follows metadata updates in place', () => {
    const affinity = new TabAffinityController()
    expect(affinity.snapshot()).toEqual({
      revision: 0,
      status: 'unbound',
      controlled: null,
      active: null,
      pinned: false,
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.observeActive(tab(1))).toBe(true)
    // 看活动标签页不会绑定它：第一次工具调用才会。
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.bindInitial(tab(1))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 1 },
      active: { tabId: 1 },
      pinned: false,
    })

    // 一个连接恰好有一个受控标签页：没有藏着的第二个目标。
    expect(affinity.bindInitial(tab(2))).toBe(false)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 1 } })

    expect(affinity.observeTab(tab(1, 'Updated title'))).toBe(true)
    expect(affinity.resolveTarget()).toMatchObject({
      kind: 'target',
      tab: { tabId: 1, title: 'Updated title' },
    })
    // 元数据没变就不算状态变化，也不能消耗一个 revision。
    expect(affinity.observeTab(tab(1, 'Updated title'))).toBe(false)

    // snapshot 是拿来广播的副本：读取方改不了被跟踪的状态。
    const exposed = affinity.snapshot()
    exposed.controlled!.title = 'tampered'
    exposed.active!.url = 'https://tampered.example/'
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 1, title: 'Updated title' },
      active: { tabId: 1, url: 'https://example.com/1' },
    })
  })

  it('fails closed on a manual switch until the matching handoff is decided', () => {
    const affinity = switchedTo(2)
    const handoff = affinity.snapshot()

    expect(handoff).toMatchObject({
      status: 'handoff',
      controlled: { tabId: 1 },
      active: { tabId: 2 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.allowsTarget(1)).toBe(false)
    expect(affinity.allowsTarget(2)).toBe(false)
    expect(affinity.tracks(1)).toBe(true)
    expect(affinity.tracks(2)).toBe(true)

    // 描述更旧 revision 的决定不得被应用。
    expect(affinity.decide('follow', handoff.revision - 1)).toBe(false)
    expect(affinity.snapshot().status).toBe('handoff')
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    expect(affinity.decide('follow', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
    expect(affinity.allowsTarget(2)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('keeps operating the bound tab in the background after an explicit keep choice', () => {
    const affinity = switchedTo(2)

    expect(affinity.decide('keep', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 1 },
      active: { tabId: 2 },
      pinned: false,
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
    expect(affinity.allowsTarget(1)).toBe(true)

    // `keep` 只管一次切换；下一次手动切换还会再问一遍。
    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({ status: 'handoff', active: { tabId: 3 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.decide('keep', affinity.snapshot().revision - 1)).toBe(false)
    expect(affinity.snapshot().status).toBe('handoff')
  })

  it('stops prompting on later tab switches after keep-always', () => {
    const affinity = switchedTo(2)

    expect(affinity.decide('keep-always', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
      active: { tabId: 2 },
    })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
    // pin 永远不会扩大工具能碰的范围。
    expect(affinity.allowsTarget(3)).toBe(false)

    // 回到受控标签页再离开，同样不能弹询问。
    affinity.observeActive(tab(1))
    expect(affinity.snapshot()).toMatchObject({ status: 'following', pinned: true })
    affinity.observeActive(tab(4))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('drops the keep-always pin whenever the binding changes', () => {
    const followed = switchedTo(2)
    followed.decide('keep-always', followed.snapshot().revision)
    followed.observeActive(tab(3))
    expect(followed.decide('follow', followed.snapshot().revision)).toBe(true)
    expect(followed.snapshot()).toMatchObject({
      status: 'following',
      pinned: false,
      controlled: { tabId: 3 },
    })
    followed.observeActive(tab(5))
    expect(followed.snapshot().status).toBe('handoff')

    const rebound = switchedTo(2)
    rebound.decide('keep-always', rebound.snapshot().revision)
    expect(rebound.rebindActive(tab(2))).toBe(true)
    expect(rebound.snapshot()).toMatchObject({
      status: 'following',
      pinned: false,
      controlled: { tabId: 2 },
    })

    const retargeted = switchedTo(2)
    retargeted.decide('keep-always', retargeted.snapshot().revision)
    expect(retargeted.rebindControlled(tab(7))).toBe(true)
    expect(retargeted.snapshot()).toMatchObject({
      status: 'background',
      pinned: false,
      controlled: { tabId: 7 },
      active: { tabId: 2 },
    })

    const closed = switchedTo(2)
    closed.decide('keep-always', closed.snapshot().revision)
    expect(closed.removeTab(1)).toBe(true)
    expect(closed.snapshot()).toMatchObject({ status: 'lost', pinned: false })
  })

  it('re-raises the prompt when the pin is undone, without rebinding', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep-always', affinity.snapshot().revision)
    affinity.observeActive(tab(3))

    const pinned = affinity.snapshot()
    expect(affinity.decide('ask-again', pinned.revision - 1)).toBe(false)
    expect(affinity.decide('ask-again', pinned.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'handoff',
      pinned: false,
      controlled: { tabId: 1 },
      active: { tabId: 3 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    // 撤销一个本来就没设的 pin 是空操作，不算状态变化。
    expect(affinity.decide('ask-again', affinity.snapshot().revision)).toBe(false)

    const neverPinned = switchedTo(2)
    expect(neverPinned.decide('ask-again', neverPinned.snapshot().revision)).toBe(false)
    expect(neverPinned.snapshot().status).toBe('handoff')
  })

  it('does not burn a revision or drop the pin when nothing tracked changed', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep-always', affinity.snapshot().revision)
    affinity.observeActive(tab(3))
    const before = affinity.snapshot()

    // 反复看同一个可见标签页，不算新的决策点。
    expect(affinity.observeActive(tab(3))).toBe(false)
    expect(affinity.snapshot()).toEqual(before)

    // 没被跟踪的标签页，其元数据同样不算一次切换。
    expect(affinity.observeTab(tab(8, 'Unrelated'))).toBe(false)
    expect(affinity.snapshot()).toEqual(before)
    expect(affinity.tracks(8)).toBe(false)

    // 刷新可见标签页自己的元数据会被报出来，pin 依然保持。
    expect(affinity.observeActive(tab(3, 'Tab 3 reloaded'))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
      active: { tabId: 3, title: 'Tab 3 reloaded' },
    })
  })

  it('rejects a keep-always pin that has no controlled tab behind it', () => {
    const unbound = new TabAffinityController()
    unbound.observeActive(tab(1))
    expect(unbound.restorePinned()).toBe(false)
    expect(unbound.snapshot().pinned).toBe(false)

    const restored = new TabAffinityController()
    restored.setSwitchMode('ask')
    expect(restored.restoreControlled(tab(1))).toBe(true)
    expect(restored.restorePinned()).toBe(true)
    restored.observeActive(tab(2))
    expect(restored.snapshot()).toMatchObject({
      status: 'background',
      pinned: true,
      controlled: { tabId: 1 },
    })
    expect(restored.restorePinned()).toBe(false)

    // 用户还没批准过的绑定，永远不能恢复 pin。
    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    expect(lost.restorePinned()).toBe(false)
    expect(lost.snapshot().pinned).toBe(false)
  })

  it('supports an explicit rebindActive that clears a pending handoff', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.rebindActive(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 2 },
      active: { tabId: 2 },
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 2 } })

    // 它也是从 fail-closed 的 lost 状态明确走回来的方式。
    expect(affinity.removeTab(2)).toBe(true)
    expect(affinity.snapshot().status).toBe('lost')
    expect(affinity.rebindActive(tab(9))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.allowsTarget(9)).toBe(true)
  })

  it('rebinds control to a listed background tab without changing the active tab', () => {
    const affinity = new TabAffinityController()
    // 正因为有这个询问，「离开标签页会再次弹出询问」才可观察，所以这个测试
    // 跑在会弹询问的模式下。
    affinity.setSwitchMode('ask')
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))

    expect(affinity.rebindControlled(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 2 },
      active: { tabId: 1 },
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 2 } })
    expect(affinity.allowsTarget(2)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)

    // 离开新受控的标签页，会为可见标签页再弹一次询问。
    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({
      status: 'handoff',
      controlled: { tabId: 2 },
      active: { tabId: 3 },
    })
  })

  it('does not silently rebind after the controlled tab closes', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.removeTab(9)).toBe(false)
    expect(affinity.removeTab(1)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'lost',
      controlled: null,
      active: { tabId: 2 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'lost' })
    expect(affinity.allowsTarget(2)).toBe(false)
    expect(affinity.bindInitial(tab(2))).toBe(false)

    // 只有明确的决定才会把工具挪到可见标签页上。
    const lost = affinity.snapshot()
    expect(affinity.decide('follow', lost.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
    expect(affinity.allowsTarget(2)).toBe(true)
  })

  it('preserves a following tab when Chrome replaces its identity', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    const before = affinity.snapshot()

    expect(affinity.replaceTab(1, 1)).toBe(false)
    expect(affinity.replaceTab(1, 9)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      revision: before.revision + 1,
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.tracks(1)).toBe(false)
    expect(affinity.allowsTarget(9)).toBe(true)

    affinity.observeTab(tab(9, 'Replacement metadata'))
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 9, title: 'Replacement metadata' },
      active: { tabId: 9, title: 'Replacement metadata' },
    })
  })

  it('preserves background affinity when either tracked tab is replaced', () => {
    const affinity = switchedTo(2)
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.replaceTab(1, 10)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 2 },
    })

    expect(affinity.replaceTab(2, 20)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 20 },
    })
    expect(affinity.allowsTarget(10)).toBe(true)
    expect(affinity.replaceTab(999, 30)).toBe(false)
  })

  it('clears the handoff if the user returns to the controlled tab', () => {
    const affinity = switchedTo(2)
    const handoff = affinity.snapshot()

    affinity.observeActive(tab(1, 'Tab 1 again'))
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      controlled: { tabId: 1, title: 'Tab 1 again' },
      active: { tabId: 1, title: 'Tab 1 again' },
    })
    expect(affinity.snapshot().revision).toBeGreaterThan(handoff.revision)
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('rehydrates controlled and lost states without allowing a fresh automatic bind', () => {
    const restored = new TabAffinityController()
    restored.setSwitchMode('ask')
    expect(restored.restoreControlled(tab(4))).toBe(true)
    expect(restored.restoreControlled(tab(5))).toBe(false)
    expect(restored.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 4 } })
    restored.observeActive(tab(5))
    expect(restored.snapshot()).toMatchObject({
      status: 'handoff',
      controlled: { tabId: 4 },
      active: { tabId: 5 },
    })

    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    expect(lost.restoreLost()).toBe(false)
    lost.observeActive(tab(5))
    expect(lost.resolveTarget()).toEqual({ kind: 'lost' })
    expect(lost.bindInitial(tab(5))).toBe(false)
    expect(lost.restoreControlled(tab(5))).toBe(false)
    expect(lost.snapshot()).toMatchObject({ status: 'lost', controlled: null })
  })

  it('refuses a follow decision unless a handoff or lost binding is waiting', () => {
    const unbound = new TabAffinityController()
    unbound.observeActive(tab(1))
    // 首次绑定是自动的，也是 fail-closed 的：光靠 follow 永远不会绑定。
    expect(unbound.decide('follow', unbound.snapshot().revision)).toBe(false)
    expect(unbound.snapshot()).toMatchObject({ status: 'unbound', controlled: null })
    expect(unbound.resolveTarget()).toEqual({ kind: 'initial' })

    const following = new TabAffinityController()
    following.observeActive(tab(1))
    following.bindInitial(tab(1))
    expect(following.decide('follow', following.snapshot().revision)).toBe(false)
    expect(following.decide('keep', following.snapshot().revision)).toBe(false)
    expect(following.decide('keep-always', following.snapshot().revision)).toBe(false)
    expect(following.snapshot()).toMatchObject({
      status: 'following',
      pinned: false,
      controlled: { tabId: 1 },
    })
  })
})

describe('isTabAffinityDecision', () => {
  it('accepts only the four control-strip decisions', () => {
    for (const value of ['keep', 'follow', 'keep-always', 'ask-again']) {
      expect(isTabAffinityDecision(value)).toBe(true)
    }
    for (const value of ['KEEP', 'follow ', '', 'deny', null, undefined, 1, {}]) {
      expect(isTabAffinityDecision(value)).toBe(false)
    }
  })
})

describe('tab switch mode', () => {
  it('follows the user by default, with no prompt', () => {
    const affinity = switchedToIn('follow', 2)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 1 } })
    // 工具目标就是用户正在看的那张页面，解析它不需要任何人做决定。
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(2) })
    expect(affinity.allowsTarget(2)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('stays on the bound tab in keep mode, with no prompt', () => {
    const affinity = switchedToIn('keep', 2)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 1 } })
    // 派发照样发往用户最初批准的那个标签页。
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(1) })
    expect(affinity.allowsTarget(1)).toBe(true)
    expect(affinity.allowsTarget(2)).toBe(false)
  })

  it('asks in ask mode, blocking dispatch until the user answers', () => {
    const affinity = switchedTo(2)
    expect(affinity.snapshot()).toMatchObject({ status: 'handoff' })
    // Fail closed：问题还悬着，就什么都不能跑。
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.allowsTarget(1)).toBe(false)
    expect(affinity.allowsTarget(2)).toBe(false)
  })

  it('changes the mode in place and reports whether anything moved', () => {
    const affinity = switchedToIn('keep', 2)
    expect(affinity.mode).toBe('keep')
    // 已经处在所请求的模式里。
    expect(affinity.setSwitchMode('keep')).toBe(false)
    expect(affinity.setSwitchMode('follow')).toBe(true)
    expect(affinity.mode).toBe('follow')
    expect(affinity.snapshot()).toMatchObject({ status: 'following' })
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(2) })
  })

  it('clears a pin when the mode becomes follow', () => {
    // pin 只是对某一次询问的回答；设置才是用户想要的，设置说了算。
    const affinity = switchedTo(2)
    expect(affinity.decide('keep-always', affinity.snapshot().revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true })

    affinity.setSwitchMode('follow')
    expect(affinity.snapshot()).toMatchObject({ status: 'following', pinned: false })
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(2) })
  })

  it('returns to the original tab when the mode becomes keep', () => {
    const affinity = switchedToIn('follow', 2)
    affinity.setSwitchMode('keep')
    expect(affinity.resolveTarget()).toEqual({ kind: 'target', tab: tab(1) })
  })

  it('models the switch mode the same way a decision does', () => {
    // 对派发来说，`keep` 和 `keep-always` 的决定必须看不出区别。
    const byMode = switchedToIn('keep', 2)
    const byDecision = switchedTo(2)
    byDecision.decide('keep-always', byDecision.snapshot().revision)
    expect(byMode.resolveTarget()).toEqual(byDecision.resolveTarget())
    expect(byMode.snapshot().status).toBe(byDecision.snapshot().status)
  })
})

describe('isTabSwitchMode', () => {
  it('accepts only the three modes', () => {
    for (const value of ['ask', 'follow', 'keep']) expect(isTabSwitchMode(value)).toBe(true)
    for (const value of ['ASK', 'always', '', null, undefined, 0, {}]) {
      expect(isTabSwitchMode(value)).toBe(false)
    }
  })
})
