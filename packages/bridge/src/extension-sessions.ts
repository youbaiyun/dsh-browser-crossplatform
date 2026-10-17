/**
 * 记录浏览器扩展经 bridge 驱动过的 session id。
 * 桌面原生 session 必须保留宿主机上的 userQuestions waterfall，桌面 UI 才渲染得出
 * ask_user_question 卡片。
 * @module dsh-browser-crossplatform/src/extension-sessions
 */

/** 扩展自有的 session id 的可变注册表。 */
export class ExtensionSessionRegistry {
  private readonly ids = new Set<string>()

  /** 记住一个由扩展成功创建、或成功发过提示的 session。 */
  note(sessionId: string | undefined): void {
    if (typeof sessionId === 'string' && sessionId.length > 0) this.ids.add(sessionId)
  }

  /** 扩展有没有通过 bridge 碰过这个 session。 */
  has(sessionId: string | undefined): boolean {
    return typeof sessionId === 'string' && this.ids.has(sessionId)
  }

  /** 测试辅助方法：丢弃所有已跟踪的 id。 */
  clear(): void {
    this.ids.clear()
  }
}

/**
 * 决定这次请求的 ask_user_question 该不该由 bridge 接管。
 * 桌面 session 必须继续走原生应答者那条 waterfall。
 */
export function shouldBridgeOwnQuestion(input: {
  hasExtensionConnection: boolean
  sessionId: string | undefined
  extensionSessions: Pick<ExtensionSessionRegistry, 'has'>
}): boolean {
  return input.hasExtensionConnection
    && input.sessionId !== undefined
    && input.extensionSessions.has(input.sessionId)
}
