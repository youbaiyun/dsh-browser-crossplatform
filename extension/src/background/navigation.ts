/**
 * 会卸载某个 frame 的动作，和装进它替代文档里的 content script 之间，
 * 做一次性会合。
 *
 * @module
 */

/** 顶替一次模型驱动的 snapshot 往返时的默认上限。 */
const NAVIGATION_READY_TIMEOUT_MS = 8_000

/** 对某个 frame 里下一个 content-script 文档的可取消等待。 */
export interface NavigationWait {
  ready: Promise<boolean>
  cancel: () => void
}

/**
 * 派发导航之前就开始监听，这样替换得快的文档，没法在动作响应和监听器装好之间
 * 抢先宣告自己已就绪。
 */
export function waitForNextDocumentReady(
  tabId: number,
  frameId: number,
  previousDocumentId: string | undefined,
  signal?: AbortSignal,
  timeoutMs: number = NAVIGATION_READY_TIMEOUT_MS,
): NavigationWait {
  let finish: (ready: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const listener = (message: unknown, sender: chrome.runtime.MessageSender): void => {
      if (typeof message !== 'object' || message === null) return
      if ((message as { type?: unknown }).type !== 'DSH_CONTENT_READY') return
      if (sender.tab?.id !== tabId || (sender.frameId ?? 0) !== frameId) return
      if (previousDocumentId !== undefined && sender.documentId === previousDocumentId) return
      // 新建的 Firefox 标签页可能把它最初的 about:blank 文档拿来跑 content script。
      // 没有基线 document id 时，只接受 browser_open_tab 导航得到的 HTTP(S) 目标文档。
      if (previousDocumentId === undefined
        && (typeof sender.url !== 'string' || !/^https?:\/\//i.test(sender.url))) return
      finish(true)
    }
    const onAbort = (): void => { finish(false) }
    finish = (isReady: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      signal?.removeEventListener('abort', onAbort)
      resolve(isReady)
    }

    if (signal?.aborted === true) {
      finish(false)
      return
    }
    chrome.runtime.onMessage.addListener(listener)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { finish(false) }, timeoutMs)
  })

  return { ready, cancel: () => { finish(false) } }
}
