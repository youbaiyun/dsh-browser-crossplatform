/**
 * `browser_open_tab` 建出来的标签页的亲和性绑定。
 *
 * 前台打开（`active !== false`）跟着新标签页走；后台打开则留着当前可见的那一个，
 * 只把受控目标重新绑过去，这样后面的工具会打到新标签页，又不会把它激活。
 *
 * @module
 */

import type { AffinityTab, TabAffinityController } from './tab-affinity.ts'

export interface BindOpenedTabOptions {
  /** 为 false 时只当受控目标绑上，不跟随可见标签页。 */
  active?: boolean
}

/**
 * 把新打开的标签页绑进亲和性控制器。
 *
 * @returns 亲和性控制器有没有接受这次绑定。
 */
export function bindOpenedTabAffinity(
  affinity: TabAffinityController,
  tab: AffinityTab,
  options: BindOpenedTabOptions = {},
): boolean {
  return options.active === false
    ? affinity.rebindControlled(tab)
    : affinity.rebindActive(tab)
}
