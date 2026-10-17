/**
 * 纯状态机：把浏览器工具绑到某一个用户看得见的标签页上。
 *
 * 控制器刻意把 Chrome 事件处理和亲和性规则分开，这样不用浏览器运行时也能测状态转换。
 * 手动切标签页绝不会悄悄换掉工具目标：它会生成一个 handoff 决策，
 * 在用户做出选择之前，工具派发一直阻塞着。
 * `keep-always` 是摆脱"每次切换都弹提示"的唯一出路：它把受控标签页钉住，
 * 之后的切换直接解析成 `background`，不用再问；`ask-again` 则在不碰绑定的前提下
 * 把这个钉撤销。钉住永远不会扩大工具够得着的范围 —— 目标仍然恰恰是用户批准过的
 * 那个标签页 —— 而且任何绑定变更都会把它清掉。
 *
 * 一条扩展连接正好拥有一个受控标签页。dsh 那边可以靠这一条绑定驱动多个会话；
 * 按会话分标签页的做法已经删掉，所以设备永远不可能藏着第二个目标。
 *
 * @module
 */

/** 某个 Chrome 标签页的精简元数据，控制条可以安全地看。 */
export interface AffinityTab {
  tabId: number
  windowId: number
  title: string
  url: string
}

export type TabAffinityStatus = 'unbound' | 'following' | 'handoff' | 'background' | 'lost'
export type TabAffinityDecision = 'keep' | 'follow' | 'keep-always' | 'ask-again'

/**
 * 手动切标签页怎么解析。
 *
 * `ask` 会弹出 handoff 提示，在它被回答之前一直卡着工具派发；
 * `follow` 把绑定挪到用户此刻正在看的那个标签页；`keep` 则让绑定留在工具原本
 * 持有的标签页上。后两个之所以存在，是因为用户一旦清楚自己要什么，
 * 每切一次就弹一次提示实在太烦 —— 而用「不要再问」回答提示，会把这个选择写到这里，
 * 于是这份偏好能活得比浏览器会话还久。
 *
 * `ask` 仍然是默认值：跟随活动标签页可能把目标从模型有意打开的那个标签页
 * （`active: false`）上挪走，所以它得主动选，不是默认行为。
 */
export type TabSwitchMode = 'ask' | 'follow' | 'keep'

/** 把不可信的设置字段收窄成一种切换模式。 */
export function isTabSwitchMode(value: unknown): value is TabSwitchMode {
  return value === 'ask' || value === 'follow' || value === 'keep'
}

/** 把不可信的控制条消息字段收窄成一个决策。 */
export function isTabAffinityDecision(value: unknown): value is TabAffinityDecision {
  return value === 'keep' || value === 'follow'
    || value === 'keep-always' || value === 'ask-again'
}

/** service worker 发给每个控制条的可序列化状态。 */
export interface TabAffinityState {
  revision: number
  status: TabAffinityStatus
  controlled: AffinityTab | null
  active: AffinityTab | null
  /** 用户选过 `keep-always` 就为 true；之后切标签页不再弹提示。 */
  pinned: boolean
}

export type TabTargetResolution =
  | { kind: 'initial' }
  | { kind: 'target'; tab: AffinityTab }
  | { kind: 'handoff' }
  | { kind: 'lost' }

function sameTab(left: AffinityTab | null, right: AffinityTab | null): boolean {
  return left?.tabId === right?.tabId
    && left?.windowId === right?.windowId
    && left?.title === right?.title
    && left?.url === right?.url
}

/** 一条扩展/桥接连接里的受控标签页生命周期。 */
export class TabAffinityController {
  private controlled: AffinityTab | null = null
  private active: AffinityTab | null = null
  private keptActiveTabId: number | null = null
  private pinned = false
  private switchMode: TabSwitchMode = 'ask'
  private hasBound = false
  private lost = false
  private revision = 0

  /**
   * 应用已经持久化的标签页切换偏好。
   *
   * 切到 `follow` 会清掉任何钉住，并让当前的活动标签页直接当目标 ——
   * 此后 {@link status} 会报 `following`，工具调用就解析到用户正在看的页面上。
   * 存下来的 `controlled` 记录会等用户下次切标签页时，经 `observeActive` 刷新。
   */
  setSwitchMode(mode: TabSwitchMode): boolean {
    if (mode === this.switchMode) return false
    this.switchMode = mode
    if (mode === 'follow') {
      this.pinned = false
      this.keptActiveTabId = null
    }
    this.revision += 1
    return true
  }

  /** 当前生效的模式，测试用得上，也要回显给面板。 */
  get mode(): TabSwitchMode {
    return this.switchMode
  }

  snapshot(): TabAffinityState {
    return {
      revision: this.revision,
      status: this.status(),
      controlled: this.controlled === null ? null : { ...this.controlled },
      active: this.active === null ? null : { ...this.active },
      pinned: this.pinned,
    }
  }

  /** 用户切了标签页/窗口焦点之后，观察活动标签页。 */
  observeActive(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) {
      this.controlled = { ...tab }
      this.keptActiveTabId = null
    } else if (previousActive?.tabId !== tab.tabId) {
      this.keptActiveTabId = null
    }
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** 刷新标题/URL 元数据，但不把它当成一次标签页切换。 */
  observeTab(tab: AffinityTab): boolean {
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.active?.tabId === tab.tabId) this.active = { ...tab }
    if (this.controlled?.tabId === tab.tabId) this.controlled = { ...tab }
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** 把第一次浏览器工具调用绑到当时的活动标签页上。 */
  bindInitial(tab: AffinityTab): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.active = { ...tab }
    this.controlled = { ...tab }
    this.hasBound = true
    this.keptActiveTabId = null
    this.pinned = false
    this.revision += 1
    return true
  }

  /** 显式重绑到活动标签页。 */
  rebindActive(tab: AffinityTab): boolean {
    this.active = { ...tab }
    this.controlled = { ...tab }
    this.keptActiveTabId = null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    this.revision += 1
    return true
  }

  /** 显式接管一个已经存在的标签页，不动浏览器当前的活动标签页。 */
  rebindControlled(tab: AffinityTab): boolean {
    this.controlled = { ...tab }
    this.keptActiveTabId = this.active !== null && this.active.tabId !== tab.tabId
      ? this.active.tabId
      : null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    this.revision += 1
    return true
  }

  /** MV3 worker 重启后，把还活着的受控标签页装回来。 */
  restoreControlled(tab: AffinityTab): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.controlled = { ...tab }
    this.hasBound = true
    this.revision += 1
    return true
  }

  /**
   * MV3 worker 重启后，把 `keep-always` 这个选择装回来。
   *
   * 只有受控标签页已经在的时候才管用，这样过期的钉住永远不会压掉一个
   * 用户还没批准过的绑定本该弹出的 handoff 提示。
   */
  restorePinned(): boolean {
    if (this.controlled === null || this.pinned) return false
    this.pinned = true
    this.revision += 1
    return true
  }

  /** 先前的受控标签页丢了，把 fail-closed 状态装回来。 */
  restoreLost(): boolean {
    if (this.controlled !== null || this.hasBound || this.lost) return false
    this.hasBound = true
    this.lost = true
    this.revision += 1
    return true
  }

  /** Chrome 关掉一个被跟踪的标签页时，把过期状态摘掉。 */
  removeTab(tabId: number): boolean {
    if (this.controlled?.tabId !== tabId && this.active?.tabId !== tabId) return false
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.controlled?.tabId === tabId) {
      this.controlled = null
      this.keptActiveTabId = null
      this.pinned = false
      this.hasBound = true
      this.lost = true
    }
    if (this.active?.tabId === tabId) this.active = null
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** Chrome 在没有用户切换的情况下换掉标签页时，把被跟踪的身份搬过去。 */
  replaceTab(removedTabId: number, addedTabId: number): boolean {
    if (removedTabId === addedTabId) return false
    if (this.controlled?.tabId !== removedTabId
      && this.active?.tabId !== removedTabId
      && this.keptActiveTabId !== removedTabId) {
      return false
    }
    const previousActive = this.active
    const previousControlled = this.controlled
    const previousKept = this.keptActiveTabId
    if (this.controlled?.tabId === removedTabId) {
      this.controlled = { ...this.controlled, tabId: addedTabId }
    }
    if (this.active?.tabId === removedTabId) {
      this.active = { ...this.active, tabId: addedTabId }
    }
    if (this.keptActiveTabId === removedTabId) this.keptActiveTabId = addedTabId
    return this.bumpIfChanged(previousActive, previousControlled, previousKept)
  }

  /** 只有控制条的选择对得上当前这个 revision 时才用它。 */
  decide(decision: TabAffinityDecision, revision: number): boolean {
    if (revision !== this.revision) return false
    const currentStatus = this.status()
    if (decision === 'ask-again') {
      // 就地撤销钉住。丢掉 keptActiveTabId，会把被这个钉住压下去的那次切换提示
      // 重新弹出来，控制权始终是用户说了算。
      if (!this.pinned) return false
      this.pinned = false
      this.keptActiveTabId = null
      this.revision += 1
      return true
    }
    if (decision === 'keep' || decision === 'keep-always') {
      if (currentStatus !== 'handoff' || this.active === null) return false
      this.keptActiveTabId = this.active.tabId
      if (decision === 'keep-always') this.pinned = true
      this.revision += 1
      return true
    }
    if (this.active === null || (currentStatus !== 'background' && currentStatus !== 'lost' && currentStatus !== 'handoff')) {
      return false
    }
    this.controlled = { ...this.active }
    this.keptActiveTabId = null
    this.pinned = false
    this.hasBound = true
    this.lost = false
    this.revision += 1
    return true
  }

  /** 解析工具能不能跑；能跑的话，由哪个标签页承载它。 */
  resolveTarget(): TabTargetResolution {
    switch (this.status()) {
      case 'unbound': return { kind: 'initial' }
      case 'lost': return { kind: 'lost' }
      case 'handoff': return { kind: 'handoff' }
      case 'following':
        // follow 模式下，目标是用户正在看的那个标签页，它可能比 `controlled`
        // 记录还新 —— 那条记录要等观察到切换才刷新，而这条路等不起。
        if (this.switchMode === 'follow' && this.active !== null) {
          return { kind: 'target', tab: { ...this.active } }
        }
        return { kind: 'target', tab: { ...this.controlled! } }
      case 'background':
        return { kind: 'target', tab: { ...this.controlled! } }
    }
  }

  tracks(tabId: number): boolean {
    return this.controlled?.tabId === tabId || this.active?.tabId === tabId
  }

  /** 最后一道派发守卫，盯的是在标签页切换之前就已经开始的异步调用。 */
  allowsTarget(tabId: number): boolean {
    const resolution = this.resolveTarget()
    return resolution.kind === 'target' && resolution.tab.tabId === tabId
  }

  private status(): TabAffinityStatus {
    if (this.controlled === null) return this.lost ? 'lost' : 'unbound'
    if (this.active?.tabId === this.controlled.tabId) return 'following'
  // 切换模式决定了手动切 tab 是什么意思，所以这个提示只在 `ask` 模式下会走到。
    if (this.switchMode === 'follow') return 'following'
    if (this.switchMode === 'keep') return 'background'
    if (this.active !== null && !this.pinned && this.keptActiveTabId !== this.active.tabId) return 'handoff'
    return 'background'
  }

  private bumpIfChanged(
    previousActive: AffinityTab | null,
    previousControlled: AffinityTab | null,
    previousKept: number | null,
  ): boolean {
    const changed = !sameTab(previousActive, this.active)
      || !sameTab(previousControlled, this.controlled)
      || previousKept !== this.keptActiveTabId
    if (changed) this.revision += 1
    return changed
  }
}
