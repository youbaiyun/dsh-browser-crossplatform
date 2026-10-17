// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bindOpenedTabAffinity } from '../src/background/open-tab-binding.ts'
import { TabAffinityController, type AffinityTab } from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return {
    tabId,
    windowId: 1,
    title,
    url: `https://example.test/${tabId}`,
  }
}

/** 一个跟着 tab 1 的 controller，也就是第一次工具调用绑定它之后的状态。 */
function following(): TabAffinityController {
  const affinity = new TabAffinityController()
  affinity.observeActive(tab(1))
  affinity.bindInitial(tab(1))
  return affinity
}

describe('bindOpenedTabAffinity', () => {
  it('rebinds active for a foreground open so later tools follow the new tab', () => {
    const affinity = following()
    const before = affinity.snapshot()

    expect(bindOpenedTabAffinity(affinity, tab(42, 'Docs'), { active: true })).toBe(true)

    expect(affinity.snapshot()).toMatchObject({
      revision: before.revision + 1,
      status: 'following',
      active: { tabId: 42 },
      controlled: { tabId: 42 },
      pinned: false,
    })
    expect(affinity.resolveTarget()).toMatchObject({
      kind: 'target',
      tab: { tabId: 42 },
    })
    expect(affinity.allowsTarget(42)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('rebinds controlled for a background open so tools target the new tab without activating it', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1, 'Current'))
    affinity.bindInitial(tab(1, 'Current'))

    expect(bindOpenedTabAffinity(affinity, tab(42, 'Docs'), { active: false })).toBe(true)

    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      active: { tabId: 1 },
      controlled: { tabId: 42 },
      pinned: false,
    })
    // 路由层的目标选择：后续 browser 工具必须打到新开的 tab，
    // 而不是那个还可见的活动 tab。
    expect(affinity.resolveTarget()).toMatchObject({
      kind: 'target',
      tab: { tabId: 42 },
    })
    expect(affinity.allowsTarget(42)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('defaults missing options to a foreground rebind', () => {
    const affinity = following()

    expect(bindOpenedTabAffinity(affinity, tab(7))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      active: { tabId: 7 },
      controlled: { tabId: 7 },
    })
    expect(affinity.snapshot().revision).toBe(3)
  })

  it('does not clear a user-visible tab that Chrome activated for the open', () => {
    // open 还在途中，Chrome 就已经激活了新 tab，
    // 于是 affinity controller 先看到了它；绑定必须保持一致。
    const affinity = following()
    affinity.observeActive(tab(42, 'Docs'))

    expect(bindOpenedTabAffinity(affinity, tab(42, 'Docs'), { active: true })).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'following',
      active: { tabId: 42 },
      controlled: { tabId: 42 },
    })
    expect(affinity.allowsTarget(42)).toBe(true)
  })

  it('recovers a lost binding when a new tab is opened', () => {
    const affinity = following()
    affinity.removeTab(1)
    expect(affinity.snapshot().status).toBe('lost')
    expect(affinity.resolveTarget()).toEqual({ kind: 'lost' })

    expect(bindOpenedTabAffinity(affinity, tab(42, 'Docs'), { active: false })).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 42 },
      active: null,
    })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 42 } })
  })
})
