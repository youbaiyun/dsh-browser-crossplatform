/**
 * bridge 插件和浏览器扩展之间的 wire 契约。
 *
 * 零依赖模块：Node 端的 bridge 和浏览器端的 bundle 都 import 这个文件，两半之间的帧形态
 * 就不可能各自漂移。每条 WebSocket 消息是一个 JSON 对象，用 `t` 做区分判别。关联 id 由
 * 请求方生成，是不透明字符串，原样回传。
 */

export const BRIDGE_PATH = '/ext/bridge'
export const BRIDGE_CONFIG_PATH = '/ext/bridge-config'

/**
 * 桌面端额外监听的固定端口，也是扩展逐个探测的列表。
 *
 * 宿主每次启动都换端口，扩展没有别的途径知道这次落在哪里，只能在固定几个端口上问
 * `/ext/bridge-config`。两端共用这一份，避免各写一份之后慢慢漂移：扩展那边少一个
 * 端口，用户看到的就是「未连接」，而日志里什么都不会有。
 */
export const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189, 19387] as const

export const BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD = 'bridge.injectBrowserSnapshot'
export const BRIDGE_SESSION_PURGE_METHOD = 'bridge.session.purge'

// 两条识别路径共用的提示词、请求体形态和解析器。在这里再导出一次，
// 这样 bridge 和扩展 import 的是同一个模块，而不是两份副本。
export * from './vision-contract.ts'

// 要求模型输出的任务清单契约，由面板解析。
// 之所以共用：讲给模型的说法和面板读到的形态
// 不能各自漂移。
export * from './plan.ts'

export const HELLO_TIMEOUT_MS = 5_000
export const PING_INTERVAL_MS = 30_000
export const DEFAULT_TOKEN_BYTES = 32
export const DEFAULT_SNAPSHOT_MAX_CHARS = 32_000
export const MIN_SNAPSHOT_MAX_CHARS = 500

/** 工具调用可能以之收场的错误码。开放集合：消费方要能容忍没见过的错误码。 */
export type ToolErrorCode =
  | 'no-active-tab'
  | 'content-unavailable'
  | 'action-failed'
  | 'timeout'
  | 'bridge-closed'
  | 'bad-args'
  | 'internal'

export interface ToolError {
  code: ToolErrorCode
  message: string
}

export type RespondResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** 在 `hello`/`hello.ok` 中协商的能力。 */
export interface BridgeCaps {
  textOnly: true
  snapshotMaxChars: number
  maxInteractiveItems: number
}

/**
 * 桌面包允许什么，而不是扩展能做什么。
 * 能力来自扩展，策略来自插件（用户配置就在那里）。两者分开，某个被关掉的开关就不会
 * 被一份过期的本地副本绕过去。
 */
export interface BridgePolicy {
  openPagesForUser: boolean
  /**
   * bridge 用来归置浏览器对话的目录。
   *
   * 发它是为了让扩展能说出正确的工作区，而不是靠猜：「工作区内」模式会镜像这个分组里的
   * 每一段对话，路径错了就会去镜像一个不相干的分组——或者什么都镜像不到。选择不分组的
   * 部署里它是缺省的，而那时候这个模式确实没什么可镜像。
   */
  sessionWorkspacePath?: string
  /**
   * 桌面端会替扩展识别图片。
   *
   * 缺省表示“这里没配置视觉模型”，不是“不支持”：这时扩展会保留自己的网络路径，不走
   * 中继。
   */
  imageRecognition?: boolean
  /**
   * 桌面端识别不了图片时，说明原因。
   *
   * 原因只有桌面端知道：配置和凭据都在它手里。没有这个字段，扩展只能报“识别不可用”，
   * 把用户丢在一个没有下一步的死胡同里。
   */
  imageRecognitionHint?: string
}

/** 随识别请求一起发过去的页面上下文，好让答案针对的就是这张图。 */
export interface ImageRecognitionRequest {
  /** manifest 身份标识，原样回传，好让扩展把请求和结果对上。 */
  identity: string
  /** 作者提供的文本（页面上有的话）。 */
  alt: string
  /** 图片旁边印着的文本。 */
  near: string
  /** 最近的标题：这张图所在的章节。 */
  heading: string
  /** manifest 的 kind：content、icon、link、button、background 或 canvas。 */
  kind: string
  /**
   * 调用方希望答案有多详细。
   *
   * 它随请求一起走，因为桌面端构造的请求体和扩展构造的完全一样；只在一侧生效的档位，
   * 会让“问了模型什么”取决于当时哪条传输通道空闲。
   *
   * 设成可选，是为了让早于档位机制的发送方仍能发出合法请求：它会拿到基础提示词，而不是
   * 被拒掉。
   */
  tier?: string
}

/**
 * 字节从哪来。
 *
 * 先向扩展要字节，因为只有它带着用户的登录状态。`url` 是回退方案，用在扩展自己的 fetch
 * 被内容安全策略、host 权限或企业策略挡住时——桌面端的网络栈不受这些约束。
 */
export type ImageSource =
  | { kind: 'bytes'; mediaType: string; base64: string }
  | { kind: 'url'; url: string }

export type ClientFrame =
  | { t: 'hello'; token: string; caps: BridgeCaps }
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  | { t: 'respond'; id: string; rpcId: string; result: RespondResult }
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  | { t: 'image.call'; id: string; request: ImageRecognitionRequest; source: ImageSource }
  | { t: 'pong' }

export type ServerFrame =
  | { t: 'hello.ok'; caps: BridgeCaps; policy: BridgePolicy }
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'respond.result'; id: string; ok: true; result: unknown }
  | { t: 'respond.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'event'; frame: { rpcId: string; method: string; payload: unknown } }
  | { t: 'tool.call'; id: string; name: string; args: Record<string, unknown>; expiresAt: number; sessionId?: string }
  | { t: 'tool.cancel'; id: string }
  | { t: 'image.result'; id: string; ok: true; desc: string }
  | { t: 'image.result'; id: string; ok: false; error: { code: string; message: string } }
  | { t: 'ping' }
  | { t: 'error'; code: string; message: string }

export type BridgeFrame = ClientFrame | ServerFrame

export function isServerFrame(frame: BridgeFrame): frame is ServerFrame {
  return frame.t === 'hello.ok'
    || frame.t === 'rpc.result'
    || frame.t === 'respond.result'
    || frame.t === 'event'
    || frame.t === 'tool.call'
    || frame.t === 'tool.cancel'
    || frame.t === 'image.result'
    || frame.t === 'ping'
    || frame.t === 'error'
}

export function isClientFrame(frame: BridgeFrame): frame is ClientFrame {
  return frame.t === 'hello'
    || frame.t === 'rpc'
    || frame.t === 'respond'
    || frame.t === 'tool.result'
    || frame.t === 'image.call'
    || frame.t === 'pong'
}

/** 把一条 WebSocket 消息解析成帧，不合法时返回 `undefined`。 */
export function parseBridgeFrame(text: string): BridgeFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const frame = value as Record<string, unknown>
  if (typeof frame.t !== 'string') return undefined
  switch (frame.t) {
    case 'hello':
      return typeof frame.token === 'string' && isCaps(frame.caps)
        ? { t: 'hello', token: frame.token, caps: frame.caps }
        : undefined
    case 'rpc':
      return typeof frame.id === 'string' && typeof frame.method === 'string'
        ? { t: 'rpc', id: frame.id, method: frame.method, payload: frame.payload }
        : undefined
    case 'respond':
      return typeof frame.id === 'string' && typeof frame.rpcId === 'string' && isRespondResult(frame.result)
        ? { t: 'respond', id: frame.id, rpcId: frame.rpcId, result: frame.result }
        : undefined
    case 'tool.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'tool.result', id: frame.id, ok: true, result: frame.result }
      }
      return isError(frame.error)
        ? { t: 'tool.result', id: frame.id, ok: false, error: frame.error as ToolError }
        : undefined
    case 'pong':
      return { t: 'pong' }
    case 'image.call':
      return typeof frame.id === 'string' && isImageRequest(frame.request) && isImageSource(frame.source)
        ? { t: 'image.call', id: frame.id, request: frame.request, source: frame.source }
        : undefined
    case 'image.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true) {
        return typeof frame.desc === 'string' ? { t: 'image.result', id: frame.id, ok: true, desc: frame.desc } : undefined
      }
      return isError(frame.error) ? { t: 'image.result', id: frame.id, ok: false, error: frame.error } : undefined
    case 'hello.ok':
      return isCaps(frame.caps) && isPolicy(frame.policy)
        ? { t: 'hello.ok', caps: frame.caps, policy: frame.policy }
        : undefined
    case 'rpc.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'rpc.result', id: frame.id, ok: true, result: frame.result }
      }
      return isError(frame.error)
        ? { t: 'rpc.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'respond.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'respond.result', id: frame.id, ok: true, result: frame.result }
      }
      return isError(frame.error)
        ? { t: 'respond.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'event':
      return isRecord(frame.frame)
        ? { t: 'event', frame: frame.frame as { rpcId: string; method: string; payload: unknown } }
        : undefined
    case 'tool.call':
      if (frame.sessionId !== undefined && (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '')) return undefined
      return typeof frame.id === 'string'
        && typeof frame.name === 'string'
        && isRecord(frame.args)
        && typeof frame.expiresAt === 'number'
        && Number.isFinite(frame.expiresAt)
        && frame.expiresAt > 0
        ? {
            t: 'tool.call',
            id: frame.id,
            name: frame.name,
            args: frame.args,
            expiresAt: frame.expiresAt,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          }
        : undefined
    case 'tool.cancel':
      return typeof frame.id === 'string' ? { t: 'tool.cancel', id: frame.id } : undefined
    case 'ping':
      return { t: 'ping' }
    case 'error':
      return typeof frame.code === 'string' && typeof frame.message === 'string'
        ? { t: 'error', code: frame.code, message: frame.message }
        : undefined
    default:
      return undefined
  }
}

export function isPolicy(value: unknown): value is BridgePolicy {
  // 字段缺失就拒掉，而不是取默认值：`false` 和“在半路上丢了”
  // 不能看起来一样。`imageRecognition` 是例外——桌面端没有视觉模型时
  // 它就是缺省的，而那是一种受支持的状态。
  return isRecord(value)
    && typeof value.openPagesForUser === 'boolean'
    && (value.imageRecognition === undefined || typeof value.imageRecognition === 'boolean')
    && (value.imageRecognitionHint === undefined || typeof value.imageRecognitionHint === 'string')
    && (value.sessionWorkspacePath === undefined || typeof value.sessionWorkspacePath === 'string')
}

function isImageRequest(value: unknown): value is ImageRecognitionRequest {
  return isRecord(value)
    && typeof value.identity === 'string'
    && typeof value.alt === 'string'
    && typeof value.near === 'string'
    && typeof value.heading === 'string'
    && typeof value.kind === 'string'
}

function isImageSource(value: unknown): value is ImageSource {
  if (!isRecord(value)) return false
  if (value.kind === 'url') return typeof value.url === 'string' && value.url !== ''
  return value.kind === 'bytes' && typeof value.mediaType === 'string' && typeof value.base64 === 'string' && value.base64 !== ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isError(value: unknown): value is { code: string; message: string } {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
}

function isCaps(value: unknown): value is BridgeCaps {
  return isRecord(value)
    && value.textOnly === true
    && typeof value.snapshotMaxChars === 'number'
    && Number.isInteger(value.snapshotMaxChars)
    && value.snapshotMaxChars >= MIN_SNAPSHOT_MAX_CHARS
    && typeof value.maxInteractiveItems === 'number'
    && value.maxInteractiveItems > 0
}

function isRespondResult(value: unknown): value is RespondResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return value.error === undefined
  if (value.ok !== false) return false
  const error = value.error
  return isError(error) && isRecord((error as Record<string, unknown>).details)
}
