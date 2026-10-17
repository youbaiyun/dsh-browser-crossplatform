/**
 * 跟踪 Chrome 最近获得焦点的窗口，同时不让过期的异步标签页结果
 * 盖掉更新的焦点或激活事件。
 *
 * @module
 */

export class FocusedWindowTracker {
  private windowId: number | null = null
  private revision = 0

  /** 开始一次查询，同时让更早的查询或激活元数据作废。 */
  beginQuery(): number {
    this.revision += 1
    return this.revision
  }

  /** 记下一个权威的焦点事件，让正在进行的查询作废。 */
  markFocused(windowId: number): void {
    this.windowId = windowId
    this.revision += 1
  }

  /** 只有没有更新的查询、焦点或激活抢先时，才接受这次查询。 */
  commitQuery(windowId: number, revision: number): boolean {
    if (revision !== this.revision) return false
    this.windowId = windowId
    return true
  }

  /** 接受一次来自已聚焦窗口的激活，让过期的工作作废。 */
  acceptActivation(windowId: number): number | null {
    if (this.windowId !== windowId) return null
    this.revision += 1
    return this.revision
  }

  /** 某个异步结果是不是还属于最近一次被接受的事件。 */
  isCurrent(revision: number): boolean {
    return this.revision === revision
  }
}
