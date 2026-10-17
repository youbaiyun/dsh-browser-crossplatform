/**
 * jsdom 测试环境：jsdom 没有布局引擎，getBoundingClientRect
 * 返回全零（可见性过滤器会读成隐藏），而且它
 * 没实现 CSS.escape。给这两个打上和浏览器行为一致的桩。
 */

const FAKE_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 40,
  width: 200,
  height: 40,
  toJSON: () => ({}),
}

Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: function getBoundingClientRect(this: Element): DOMRect {
    return FAKE_RECT
  },
})

Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {
    escape(value: string): string {
      return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
    },
  },
})

/**
 * 一个可控的 `requestAnimationFrame`。
 *
 * 面板把流式重绘合并成每帧一次，长回复因此
 * 才不会把它冻住。jsdom 完全没实现 `requestAnimationFrame`，所以没有
 * 这个桩，每个流式 spec 都会抛错。与其为了等一帧把 spec 改成异步，
 * 不如把回调留在这里按需释放。
 *
 * 不会自己跑任何东西：要打印输出的 spec 必须调 `flushAnimationFrames()`，这也
 * 让合并行为变得可观测——一帧量的增量只会触发一次重绘。
 */
export const flushAnimationFrames = (maxRounds = 8): void => {
  for (let round = 0; round < maxRounds; round++) {
    const pending = pendingFrames.splice(0, pendingFrames.length)
    if (pending.length === 0) return
    for (const callback of pending) callback(0)
  }
}

const pendingFrames: Array<(time: number) => void> = []

Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  writable: true,
  value: (callback: (time: number) => void): number => {
    pendingFrames.push(callback)
    return pendingFrames.length
  },
})

Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  configurable: true,
  writable: true,
  value: (): void => {
    pendingFrames.length = 0
  },
})

/**
 * 任何测试都不许访问网络。
 *
 * 后台会探测回环端口找 bridge，所以一个加载了它
 * 却没打桩 `fetch` 的 spec，会去跟开发者恰好正开着的
 * 东西对话。这会让结果取决于机器而不是代码，而
 * 这种差异通常会在别人的 checkout 上冒出来。
 *
 * 需要 bridge 的 spec 自己打桩 `fetch`。其余的都拿到
 * 一个拒绝，这正是「这个端口上没有 bridge」的样子。
 *
 * 这是一道防线，不是针对某个已知失败的修复：今天有没有它
 * 测试套件都能通过。它在这儿就是为了让这一点一直成立。
 */
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: () => Promise.reject(new Error('ECONNREFUSED: tests never reach the network')),
})
