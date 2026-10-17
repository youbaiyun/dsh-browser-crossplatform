/**
 * 工具分发：在显式选定的标签页里通过 content script 执行 `tool.call` 帧，再用纯文本结果作答。
 *
 * 标签页亲和策略归 background service 管。为了让隔离测试里的活动标签页分发保持向后兼容，
 * 直接调用方可以省掉目标。
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@dsh-browser/protocol'
import type { ToolError } from '@dsh-browser/protocol'
import type { ImageIdentity, ImageTarget } from '../content/actions.ts'
import { fillMarkers, hasMarkers, stripMarkers } from '../markers.ts'
import type { VisionSink } from './vision.ts'
import {
  allocateFrameBudgets,
  frameDocumentKey,
  frameOrigin,
  listTabFrames,
  type TabFrame,
} from './frames.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { approvalPromptForCall, originFromUrl } from './authorization.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'

/** 来自 bridge 的一次工具调用。 */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** 服务器给的墙钟截止时间；只有直接单元测试里才会缺。 */
  expiresAt?: number
  /** 发起这次调用的 Agent 会话；当前 bridge 提供了才有值。 */
  sessionId?: string
}

/** 一次工具调用的线上应答。 */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** 和 bridge 协商好、惰性注入之后再转发的快照限制。 */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

const CONTENT_SCRIPT_FILE = 'content.js'
const ACTION_DELTA_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_wait',
])
const ACTION_DELTA_GUIDANCE = 'The page settled and its current changes are included below. Continue from this state; take another snapshot only when broader page context is needed.'
const NAVIGATION_CANDIDATE_TOOLS = new Set([
  'browser_click',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_open_tab',
])
const TAB_NATIVE_TOOLS = new Set([
  'browser_snapshot',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
const STATE_CHANGING_PAGE_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
/** 操作对象是整个标签页集合、不是某个页面文档的工具。 */
export const TAB_MANAGEMENT_TOOL_NAMES = new Set([
  'browser_list_tabs',
  'browser_follow_tab',
  'browser_close_tab',
])

/**
 * 这个 worker 能执行的每一个 `browser_*` 工具。
 *
 * 排过序，所以这份列表能原样放进拒绝消息里。用户输入的命令就以它为准：不在集合里的名字在分发
 * 任何东西之前就被拒掉，因为未知名字没有可校验的调用形态，绝不能让它们到页面上。
 */
export const BROWSER_TOOL_NAMES: readonly string[] = [
  'browser_back',
  'browser_click',
  'browser_close_tab',
  'browser_follow_tab',
  'browser_forward',
  'browser_get_text',
  'browser_list_tabs',
  'browser_navigate',
  'browser_open_tab',
  'browser_press',
  'browser_reload',
  'browser_scroll',
  'browser_snapshot',
  'browser_type',
  'browser_wait',
]
const NAVIGATION_SNAPSHOT_GUIDANCE = 'Navigation completed and the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.'
const pendingInjections = new Map<number, Promise<void>>()
const snapshotDocumentsByTab = new Map<number, Map<number, string>>()

/** 用户显式跟到一个新标签页时，把 delta/element 状态忘掉。 */
export function resetTabSnapshot(tabId: number): void {
  snapshotDocumentsByTab.delete(tabId)
}

/** 一次成功的工具调用有没有可能改掉受控标签页的页面 URL。 */
export function isNavigationCandidateTool(name: string): boolean {
  return NAVIGATION_CANDIDATE_TOOLS.has(name)
}

/** 这个工具是不是不用先解析当前受控标签页就能跑。 */
export function isTabManagementTool(name: string): boolean {
  return TAB_MANAGEMENT_TOOL_NAMES.has(name)
}

/** 由 background 入口点持有的标签页亲和服务。 */
export interface TabManagementContext {
  /** 用户开了不受限访问之后，所有浏览器审批提示都跳过。 */
  unrestrictedAccess: boolean
  /** 调用方会话的受控标签页（还在的话）。 */
  controlledTabId?: number
  /** 把后续工具重新绑到某个已有标签页上，但不激活它。 */
  followTab?: (tab: chrome.tabs.Tab) => void | Promise<void>
  /** 标记一个时点，过了它，状态变更操作就撤不回来了。 */
  commitAction?: () => void
  /** content-script 操作没送到时，把可撤回性恢复回来。 */
  rollbackActionCommit?: () => void
}

function isToolAnswer(value: unknown): value is ToolAnswer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function isInjectablePage(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/** 每个标签页只注入一次打包好的 content script，并发来的恢复尝试合并成一次。 */
async function injectContentScript(tabId: number): Promise<void> {
  let pending = pendingInjections.get(tabId)
  if (pending === undefined) {
    pending = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    }).then(() => undefined)
    pendingInjections.set(tabId, pending)
  }
  try {
    await pending
  } finally {
    if (pendingInjections.get(tabId) === pending) pendingInjections.delete(tabId)
  }
}

/**
 * 一次*小动作*分发最多能多久不回来：click、type、press、scroll、select。
 *
 * 它们只做一件有边界的事、立刻作答，所以等这么久就说明接收端已经没了，而不是忙。
 */
export const CONTENT_ACTION_TIMEOUT_MS = 10_000

/**
 * 一次必须把整个页面序列化出来的分发，最多能多久不回来。
 *
 * `browser_snapshot` 和 `browser_get_text` 要遍历实时 DOM（含内联 frame），在重型页面上确实
 * 慢——是秒级，不是毫秒级。以前一刀切的十秒上限会在这种活儿干到一半时把它取消，报成脚本无响应，
 * 于是“这个页面很大”就变成了“这个页面坏了”。上限还是留着，因为一次永远不结束的调用是模型连
 * 反应都做不出来的唯一一种失败；只是把它放到慢但真实的工作也装得下的位置上。
 */
export const CONTENT_READ_TIMEOUT_MS = 30_000

/** 分发出去要序列化页面内容、而不是执行单个操作的那些工具。 */
const CONTENT_READ_TOOLS = new Set(['browser_snapshot', 'browser_get_text'])

/** 单次分发的上限，看这次分发要干什么。 */
function contentActionTimeoutMs(call: ToolCall): number {
  return CONTENT_READ_TOOLS.has(call.name) ? CONTENT_READ_TIMEOUT_MS : CONTENT_ACTION_TIMEOUT_MS
}

/**
 * 派发出去、始终没等到应答时，统一用这一句话回报。
 *
 * 共用一句，是为了让走到这儿的两条路——恢复路径里没能归类的拒绝，以及
 * {@link CONTENT_ACTION_TIMEOUT_MS} 这个上限——在模型读来完全一样。两者都意味着“这次分发可能
 * 执行了，也可能没有”；两者都证不出它没执行，所以这两条路上恢复逻辑都刻意不重新分发，措辞也是
 * 让模型重新 `browser_snapshot` 一次，而不是盲目重试同一个调用。
 */
const DISPATCH_UNANSWERED = 'The content script stopped responding after the operation was dispatched. Call browser_snapshot before continuing.'

async function sendAction(
  tabId: number,
  call: ToolCall,
  frame: TabFrame,
  budget?: ContentBudget,
  includePageDelta: boolean = false,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(DISPATCH_UNANSWERED)) }, contentActionTimeoutMs(call))
  })
  try {
    // `finally` 成功和失败两条路上都会清定时器，所以响应再快也不会留下一个挂着的定时器，
    // 把 worker 一直唤醒。
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: 'DSH_ACTION',
        action: call.name,
        args: withoutFrame(call.args),
        ...budget === undefined ? {} : { budget },
        ...includePageDelta ? { includePageDelta: true } : {},
      }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId }),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 一次分发失败，是不是意味着接收方已经不在了。
 *
 * 自愈路径（先注入、再重新分发）只在接收端*确实没了*时才安全：替换文档里那个全新的 content
 * script 正是重试需要的东西。所以这里刻意只认“另一端不在那儿”的形态——frame 没了、文档被销毁、
 * 上下文失效。
 *
 * 它绝不能匹配一次操作已经派发*之后*才关掉的消息端口。从这儿看两者一模一样，但它们不是同一件
 * 事：页面可能已经把操作做了，只是回复丢了，而凭这条证据重新分发 `browser_click` 会点两次。
 * 这种发送方有意报成不可恢复；{@link sendAction} 里的超时也一样从不重试。
 *
 * frame 消息按里面的数字匹配，不按裸短语 `was removed` 匹配。宽松的子串会把页面来的无关失败也
 * 一起吞掉——某个元素、某个 observer、某个 listener——而这里每匹配一次，就同时授权一次重新分发
 * 和一次状态变更操作的回滚。范围必须窄，不然一次真点击就变成两次。
 */
function contentScriptReceiverMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message
  if (message.includes('Receiving end does not exist')) return true
  if (message.includes('Could not establish connection')) return true
  if (/frame with id \d+ was removed/iu.test(message)) return true
  if (message.includes('Extension context invalidated')) return true
  return false
}

/**
 * 每个带编号的图片，在最后一次为它编号的那份快照里是什么。
 *
 * 元素索引是 per-frame 的命名空间，页面一次重渲染就能让它失效，而模型指代图片用的就是编号。
 * 记住一个编号曾经指向哪个地址，才把过期索引从死路变成 content script 还能解析的东西。键按
 * 标签页和 frame 分，因为两个 frame 里的同一个编号是两张不同的图片。
 */
const rememberedImageIdentities = new Map<string, Map<number, string>>()

/** 超过这个数量，最旧的已记住编号就被丢掉。 */
const REMEMBERED_IDENTITY_LIMIT = 500
/**
 * tab/frame 键超过这么多个，最久没被快照过的 frame 就被丢掉。
 *
 * 只卡内层上限照样会漏：关掉的标签页、销毁的 iframe 会把自己的键永远留着，而没有任何回调来说
 * 这个 frame 没了。键的数量会随着每个被快照过的标签页和 iframe 往上涨，所以它得有自己的上限，
 * 不能只给每个键里的内容设上限。
 */
const REMEMBERED_IDENTITY_KEY_LIMIT = 64

function identityMemoryKey(tabId: number, frameId: number): string {
  return `${String(tabId)}:${String(frameId)}`
}

/**
 * 记下一次快照应答带来的身份映射。
 *
 * 按 frame 调用，传的也是该 frame 自己的映射，这样编号绝不会从错的文档那儿学来。
 *
 * @param tabId - 拍下这张快照的标签页。
 * @param frameId - 这个映射所属的 frame。
 * @param identities - 该 frame 报上来的身份。
 */
export function rememberImageIdentities(
  tabId: number,
  frameId: number,
  identities: readonly ImageIdentity[],
): void {
  if (identities.length === 0) return
  const key = identityMemoryKey(tabId, frameId)
  const byNumber = rememberedImageIdentities.get(key) ?? new Map<number, string>()
  for (const entry of identities) byNumber.set(entry.index, entry.identity)
  // 有上限：一个长期活着的 frame 不能为每张图无限攒编号。
  while (byNumber.size > REMEMBERED_IDENTITY_LIMIT) {
    const oldest = byNumber.keys().next()
    if (oldest.done === true) break
    byNumber.delete(oldest.value)
  }
  // 先删再插，不直接 `set`：对已有的键 set 会保住它原来的位置，下面的键上限就只能按创建顺序
  // 驱逐，而不是按哪个 frame 最久没被快照过。
  rememberedImageIdentities.delete(key)
  rememberedImageIdentities.set(key, byNumber)
  while (rememberedImageIdentities.size > REMEMBERED_IDENTITY_KEY_LIMIT) {
    const oldest = rememberedImageIdentities.keys().next()
    if (oldest.done === true || oldest.value === key) break
    rememberedImageIdentities.delete(oldest.value)
  }
}

/** 暴露给测试：之后 describe 调用会当作提示提供的内容。 */
export { rememberedImageIdentities }

/**
 * 在受控标签页上解析出一张图片，给视觉流水线用。
 *
 * 留在这个模块里，是因为注入、frame 选择和应答校验本来就归它管：视觉路径不用再实现一遍，真
 * 实现一遍，两份代码对“什么才算有效的页面应答”迟早会不一致。
 *
 * @param tabId - 受控标签页。
 * @param index - 这张图在最新快照里的清单索引。
 * @param frameId - 拥有该索引的 frame；元素索引是按 frame 分的。
 * @param signal - bridge 生命周期；取消会在任何页面操作之前停下。
 * @returns 解析出的图片，或一个稳定的错误应答。
 */
export async function requestImageTarget(
  tabId: number,
  index: number,
  frameId: number,
  signal?: AbortSignal,
): Promise<{ ok: true; target: ImageTarget } | { ok: false; error: ToolError }> {
  if (signal?.aborted === true) {
    return { ok: false, error: { code: 'bridge-closed', message: 'the bridge connection ended before the image was resolved' } }
  }
  const frames = await listTabFrames(tabId, undefined)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return { ok: false, error: { code: 'action-failed', message: `Frame ${String(frameId)} does not exist or has navigated. Call browser_snapshot again.` } }
  }
  // 这个提示是该编号拍快照时的含义。只当回退发出去：content script 先用实时索引，索引解析不出来
  // 了才轮到它。
  const remembered = rememberedImageIdentities.get(identityMemoryKey(tabId, frameId))?.get(index)
  const call: ToolCall = {
    id: 'image-target',
    name: 'browser_describe_image',
    args: remembered === undefined ? { index } : { index, identity: remembered },
  }
  let response: unknown
  try {
    response = await sendAction(tabId, call, frame)
  } catch (error: unknown) {
    // 在 worker 起来之前就恢复的标签页还没有 content script；注入一次，就是“没有这张图片”和
    // “没人听”的区别。
    if (!contentScriptReceiverMissing(error)) throw error
    // 注入和第二次分发都用模型已经在用的词作答。放任任何一个拒绝逃出去，这次调用就会被报成
    // `internal`，既没指出任何页面级原因，也没给下一步，而对同一个页面，一次普通快照会说它是
    // `content-unavailable`。
    try {
      await injectContentScript(tabId)
      response = await sendAction(tabId, call, frame)
    } catch {
      return {
        ok: false,
        error: {
          code: 'content-unavailable',
          message: 'The content script could not be loaded on this page, so the image could not be resolved. Call browser_snapshot again before retrying.',
        },
      }
    }
  }
  if (!isToolAnswer(response)) {
    return { ok: false, error: { code: 'content-unavailable', message: 'The page content script returned an invalid response.' } }
  }
  if (!response.ok) {
    // `ToolAnswer.ok` 只是个普通布尔值，不是判别式，所以这里把失败重建出来，不靠类型收窄。
    return {
      ok: false,
      error: response.error ?? { code: 'content-unavailable', message: 'The page refused to describe that image.' },
    }
  }
  const target = (response.result as { image?: unknown }).image
  if (!isImageTarget(target)) {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: `The page did not resolve element [${String(index)}] to an image that browser_snapshot listed.` },
    }
  }
  return { ok: true, target }
}

/** content 应答里的 `image` 字段是不是流水线要的形态。 */
function isImageTarget(value: unknown): value is ImageTarget {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as ImageTarget
  return typeof candidate.identity === 'string' && candidate.identity !== ''
    && typeof candidate.alt === 'string'
    && typeof candidate.near === 'string'
    && typeof candidate.heading === 'string'
    && typeof candidate.kind === 'string'
    && typeof candidate.src === 'string'
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

function tabMetadataSnapshot(
  tabId: number,
  windowId: number | undefined,
  title: string | undefined,
  url: string | undefined,
  maxChars: number,
): ToolAnswer {
  const status = 'The current tab is available only through browser-level controls because its page DOM is protected or inaccessible. DOM snapshot, click, type, press, scroll, wait, and text extraction are unavailable here. Navigate, back, forward, and reload remain available.'
  const separator = '\n\n'
  const remaining = maxChars - status.length - separator.length
  if (remaining <= 0) return { ok: true, result: { text: status.slice(0, maxChars) } }
  return {
    ok: true,
    result: {
      text: `${status}${separator}${wrapUntrustedContent([
        `Tab ID: ${tabId}`,
        `Window ID: ${windowId ?? '(unknown)'}`,
        `Title: ${title ?? '(unknown)'}`,
        `URL: ${url ?? '(unknown)'}`,
      ].join('\n'), remaining)}`,
    },
  }
}

async function dispatchTabNativeTool(
  tabId: number,
  tabUrl: string | undefined,
  tabTitle: string | undefined,
  windowId: number | undefined,
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  commitAction?: () => void,
): Promise<ToolAnswer | undefined> {
  if (call.name === 'browser_snapshot') return tabMetadataSnapshot(tabId, windowId, tabTitle, tabUrl, budget.maxChars)
  if (!TAB_NATIVE_TOOLS.has(call.name)) return undefined
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()

  let operation: Promise<unknown>
  let text: string
  try {
    switch (call.name) {
      case 'browser_navigate': {
        const requested = parseHttpUrl(call.args.url)
        if (requested === undefined) {
          return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
        }
        commitAction?.()
        operation = chrome.tabs.update(tabId, { url: requested.href })
        text = `Navigating to ${requested.href}. Call browser_snapshot again after the page loads.`
        break
      }
      case 'browser_back':
        commitAction?.()
        operation = chrome.tabs.goBack(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_forward':
        commitAction?.()
        operation = chrome.tabs.goForward(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_reload':
        commitAction?.()
        operation = chrome.tabs.reload(tabId)
        text = 'The page is reloading. Call browser_snapshot again after it loads.'
        break
      default:
        return undefined
    }
    resetTabSnapshot(tabId)
    await operation
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return unavailable(`The browser-level operation failed: ${detail}`)
  }
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  return { ok: true, result: { text, navigationPending: true } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** 只把审批的既成事实告诉模型，不规定它该怎么回应。 */
function approvalFailure(approval: ApprovalPrompt, authorization: Exclude<ApprovalAuthorization, 'approved'>): ToolAnswer {
  switch (authorization) {
    case 'denied':
      return {
        ok: false,
        error: { code: 'action-failed', message: `The user denied the browser approval request for "${approval.action}".` },
      }
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `No browser side panel was available to receive or complete the approval request for "${approval.action}".`,
        },
      }
    case 'timed-out':
      return {
        ok: false,
        error: { code: 'timeout', message: `The browser approval request for "${approval.action}" timed out before the user responded.` },
      }
    case 'cancelled':
      return {
        ok: false,
        error: { code: 'bridge-closed', message: `The browser approval request for "${approval.action}" was cancelled.` },
      }
  }
}

function targetChanged(): ToolAnswer {
  return unavailable('The controlled tab changed during the operation. Confirm the page in the side panel before retrying.')
}

function isCancelled(call: ToolCall, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function withoutFrame(args: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = args
  return rest
}

function requestedFrame(args: Record<string, unknown>): number {
  const value = args.frame
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return -1
  return value
}

function answerText(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const text = (answer.result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function answerPageContent(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const pageContent = (answer.result as { pageContent?: unknown }).pageContent
  return typeof pageContent === 'string' ? pageContent : undefined
}

function answerNavigationPending(answer: ToolAnswer): boolean {
  return answer.ok
    && typeof answer.result === 'object'
    && answer.result !== null
    && (answer.result as { navigationPending?: unknown }).navigationPending === true
}

/** 让扩展自己写的操作状态待在受 nonce 约束的页面数据边界之外。 */
function wrapActionDelta(status: string, pageContent: string, frame: TabFrame, maxChars: number): string {
  const prefix = `${status}\n${ACTION_DELTA_GUIDANCE}`
  const separator = '\n\n'
  const boundaryBudget = maxChars - prefix.length - separator.length
  if (boundaryBudget < 500) return prefix.slice(0, maxChars)
  const framedContent = frame.frameId === 0 ? pageContent : `${frameHeader(frame)}\n${pageContent}`
  return `${prefix}${separator}${wrapUntrustedContent(framedContent, boundaryBudget)}`
}

async function snapshotAllFrames(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  vision?: VisionSink,
): Promise<ToolAnswer> {
  const budgets = allocateFrameBudgets(frames, budget)
  const previous = snapshotDocumentsByTab.get(tabId) ?? new Map<number, string>()
  const deltaRequested = call.args.delta === true

  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const sameDocument = previous.get(frame.frameId) === frameDocumentKey(frame)
    const frameCall: ToolCall = {
      ...call,
      args: deltaRequested && sameDocument ? call.args : { ...call.args, delta: false },
    }
    const response = await sendAction(tabId, frameCall, frame, budgets.get(frame.frameId))
    return { frame, response }
  }))

  const sections: string[] = []
  const capturedDocuments = new Map<number, string>()
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!
    const frame = frames[index]!
    if (outcome.status === 'rejected') {
      if (frame.frameId === 0) throw outcome.reason
      sections.push(frameHeader(frame), '(This iframe was inaccessible or destroyed while loading.)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('The page content script returned an invalid response.')
      sections.push(frameHeader(frame), '(This iframe returned an invalid response.)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      sections.push(frameHeader(frame), `(This iframe could not be read: ${answer.error?.message ?? 'unknown error'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frameDocumentKey(frame))
    // 按 frame 填充，用的是该 frame 自己的身份映射：元素索引是 per-frame 的命名空间，两个
    // iframe 里的同一个编号是两张不同的图片，全标签页范围一起填就会描述错的那张。
    const filled = fillImageStates(text, answer, vision)
    // 这份映射渲染之后还留着：一个在页面重渲染之后才到的 describe 调用，得知道给它的那个编号
    // 曾经指向什么。
    rememberImageIdentities(tabId, frame.frameId, answerImageIdentities(answer))
    // 只有主 frame 的文本会被记成“这个页面”：否则侧边栏、广告 iframe 会拿自己的编号盖掉页面
    // 自己的编号。
    if (frame.frameId === 0) vision?.sawPageText(stripMarkers(text))
    if (frame.frameId === 0) sections.push(filled)
    else sections.push(frameHeader(frame), filled)
  }

  if (deltaRequested) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\nRemoved iframes: ${removed.join(', ')}`)
  }

  snapshotDocumentsByTab.set(tabId, capturedDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

function stripDuplicateSnapshotPrompt(status: string): string {
  return status.replace(/ Call browser_snapshot again after (?:navigation settles|the page loads|it loads)\.$/, '')
}

async function snapshotAfterNavigation(
  tabId: number,
  call: ToolCall,
  status: string,
  budget: ContentBudget,
  targetStillAllowed?: () => boolean,
  vision?: VisionSink,
): Promise<ToolAnswer | undefined> {
  const prefix = `${stripDuplicateSnapshotPrompt(status)}\n${NAVIGATION_SNAPSHOT_GUIDANCE}`
  const snapshotMaxChars = budget.maxChars - prefix.length - 2
  if (snapshotMaxChars < 500) return undefined
  const frames = await listTabFrames(tabId, undefined)
  if (targetStillAllowed?.() === false) return targetChanged()
  const answer = await snapshotAllFrames(
    tabId,
    frames,
    { ...call, name: 'browser_snapshot', args: {} },
    { ...budget, maxChars: snapshotMaxChars },
    vision,
  )
  const snapshot = answerText(answer)
  if (snapshot === undefined) return undefined
  return { ok: true, result: { text: `${prefix}\n\n${snapshot}` } }
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  includeActionDelta: boolean = false,
  commitAction?: () => void,
  rollbackActionCommit?: () => void,
  vision?: VisionSink,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (call.name === 'browser_snapshot') return snapshotAllFrames(tabId, frames, call, budget, vision)

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  // 从这个 guard 到 tabs.sendMessage 之间不会 await，所以过了期的审批越不过最后那道状态变更
  // 分发边界。
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(frameId) === frameDocumentKey(frame)
  const requestPageDelta = includeActionDelta && hasSnapshotBaseline && ACTION_DELTA_TOOLS.has(call.name)
  const navigationWait = includeActionDelta && isNavigationCandidateTool(call.name)
    ? waitForNextDocumentReady(tabId, frameId, frame.documentId, signal)
    : undefined
  let response: unknown
  const stateChanging = STATE_CHANGING_PAGE_TOOLS.has(call.name)
  try {
    if (stateChanging) commitAction?.()
    response = await sendAction(
      tabId,
      call,
      frame,
      requestPageDelta ? budget : undefined,
      requestPageDelta,
    )
  } catch (error: unknown) {
    if (stateChanging && contentScriptReceiverMissing(error)) rollbackActionCommit?.()
    navigationWait?.cancel()
    throw error
  }
  if (isCancelled(call, signal)) {
    navigationWait?.cancel()
    return cancelled()
  }
  if (!isToolAnswer(response)) {
    navigationWait?.cancel()
    return unavailable('The page content script returned an invalid response.')
  }
  const text = answerText(response)
  if (text === undefined) {
    navigationWait?.cancel()
    return response
  }
  if (answerNavigationPending(response) && navigationWait !== undefined) {
    const ready = await navigationWait.ready
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (ready) {
      try {
        const snapshot = await snapshotAfterNavigation(tabId, call, text, budget, targetStillAllowed, vision)
        if (snapshot !== undefined) return snapshot
      } catch {
        // 替换页面在机会性快照做完之前就读不了时，导航成功这个状态保留着。
      }
    }
  } else {
    navigationWait?.cancel()
  }
  if (call.name === 'browser_get_text') {
    vision?.sawPageText(stripMarkers(text))
    return { ok: true, result: { text: wrapUntrustedContent(fillImageStates(text, response, vision), budget.maxChars) } }
  }
  const pageContent = requestPageDelta ? answerPageContent(response) : undefined
  if (pageContent !== undefined) vision?.sawPageText(stripMarkers(pageContent))
  return {
    ok: true,
    result: {
      text: pageContent === undefined
        ? fillImageStates(text, response, vision)
        : wrapActionDelta(fillImageStates(text, response, vision), fillImageStates(pageContent, response, vision), frame, budget.maxChars),
    },
  }
}

/**
 * 把应答里的图片标记换成每张图已知的信息。
 *
 * 只有这儿能同时看到两半：content script 渲染出的文本（它给图片编号），以及视觉流水线手里的
 * 状态（按身份存）。在这里填、而不是在 content script 里填，一段描述才能在请求它的那次快照之后
 * 的快照上到达模型——也才能让一张还在识别中的图标明自己正在识别，而不是不吭声。
 *
 * @param text - 已渲染的文本，可能含标记。
 * @param response - content script 的应答，带着身份映射。
 * @param vision - 按身份查状态；缺失就不动标记。
 * @returns 填充后的文本。
 */
function fillImageStates(
  text: string,
  response: ToolAnswer,
  vision: VisionSink | undefined,
): string {
  if (vision === undefined || !response.ok) return text
  const identities = answerImageIdentities(response)
  if (identities.length === 0 || !hasMarkers(text)) return text
  const identityByIndex = new Map(identities.map((entry) => [entry.index, entry]))
  return fillMarkers(text, (index) => {
    const entry = identityByIndex.get(index)
    if (entry === undefined) return undefined
    // 页面已经知道的东西优先于缓存可能知道的：加载失败的图片永远不会被请求，所以它不可能有
    // 缓存条目。
    if (entry.unavailable !== undefined) return `unavailable:${entry.unavailable}`
    return vision.states(entry.identity)
  })
}

/** 暴露给测试：填充是已渲染文本和结果之间唯一的连接点。 */
export { fillImageStates }

/** content 应答带的身份映射，前提是它给图片编过号。 */
function answerImageIdentities(answer: ToolAnswer): ImageIdentity[] {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return []
  const identities = (answer.result as { imageIdentities?: unknown }).imageIdentities
  if (!Array.isArray(identities)) return []
  return identities.filter((entry): entry is ImageIdentity => typeof entry === 'object' && entry !== null
    && typeof (entry as ImageIdentity).index === 'number'
    && typeof (entry as ImageIdentity).identity === 'string')
}

function requestedTabId(args: Record<string, unknown>): number | undefined {
  const value = args.tabId
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tabUrl(tab: chrome.tabs.Tab): string {
  return tab.url ?? tab.pendingUrl ?? ''
}

function approvalDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    const display = url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}//${url.host}${url.pathname}`
    return display.replace(/\s+/g, ' ').slice(0, 160)
  } catch {
    return '(unknown URL)'
  }
}

function tabManagementApproval(call: ToolCall, tab?: chrome.tabs.Tab): ApprovalPrompt {
  const locale = getUiLocale()
  if (call.name === 'browser_list_tabs') {
    return {
      kind: 'read',
      action: call.name,
      summary: locale === 'zh' ? '读取所有已打开标签页的标题和链接' : 'Read the titles and URLs of all open tabs',
      origins: [],
      canTrust: false,
    }
  }
  const url = tab === undefined ? '' : tabUrl(tab)
  const origin = originFromUrl(url)
  const display = approvalDisplayUrl(url)
  return {
    kind: 'action',
    action: call.name,
    summary: call.name === 'browser_follow_tab'
      ? (locale === 'zh' ? `跟随标签页 ${tab?.id ?? '?'}：${display}` : `Follow tab ${tab?.id ?? '?'}: ${display}`)
      : (locale === 'zh' ? `关闭标签页 ${tab?.id ?? '?'}：${display}` : `Close tab ${tab?.id ?? '?'}: ${display}`),
    origins: origin === undefined ? [] : [origin],
    canTrust: false,
  }
}

async function authorizeTabManagement(
  prompt: ApprovalPrompt,
  unrestrictedAccess: boolean,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolAnswer | undefined> {
  if (unrestrictedAccess) return undefined
  const authorization = authorize === undefined ? 'unavailable' : await authorize(prompt)
  if (isCancelled(call, signal)) return cancelled()
  return authorization === 'approved' ? undefined : approvalFailure(prompt, authorization)
}

async function findTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }
}

async function dispatchTabManagementTool(
  call: ToolCall,
  budget: ContentBudget,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  context: TabManagementContext,
): Promise<ToolAnswer> {
  if (call.name === 'browser_list_tabs') {
    const approval = tabManagementApproval(call)
    const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
    if (rejected !== undefined) return rejected
    const tabs = await chrome.tabs.query({})
    if (isCancelled(call, signal)) return cancelled()
    const records = tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
      .map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        controlled: tab.id === context.controlledTabId,
        title: tab.title ?? '',
        url: tabUrl(tab),
      }))
    return {
      ok: true,
      result: { text: wrapUntrustedContent(JSON.stringify({ tabs: records }, null, 2), budget.maxChars) },
    }
  }

  const tabId = requestedTabId(call.args)
  if (tabId === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'tabId must be a non-negative safe integer returned by browser_list_tabs.' } }
  }
  const before = await findTab(tabId)
  if (before === undefined) return unavailable(`Tab ${tabId} is no longer open. Call browser_list_tabs again.`)
  const approval = tabManagementApproval(call, before)
  const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
  if (rejected !== undefined) return rejected
  const current = await findTab(tabId)
  if (current === undefined) return unavailable(`Tab ${tabId} closed while approval was pending. Call browser_list_tabs again.`)
  if (tabUrl(current) !== tabUrl(before)) {
    return unavailable(`Tab ${tabId} navigated while approval was pending. Call browser_list_tabs again before retrying.`)
  }
  if (isCancelled(call, signal)) return cancelled()

  if (call.name === 'browser_follow_tab') {
    if (context.followTab === undefined) return unavailable('The browser could not bind the selected tab in this session.')
    context.commitAction?.()
    await context.followTab(current)
    return {
      ok: true,
      result: { text: `Tab ${tabId} is now the controlled tab. Call browser_snapshot before operating its page.` },
    }
  }
  if (call.name === 'browser_close_tab') {
    try {
      context.commitAction?.()
      await chrome.tabs.remove(tabId)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return unavailable(`Tab ${tabId} could not be closed: ${detail}`)
    }
    return {
      ok: true,
      result: {
        text: tabId === context.controlledTabId
          ? `Closed controlled tab ${tabId}. Call browser_list_tabs and browser_follow_tab before the next page operation.`
          : `Closed tab ${tabId}.`,
      },
    }
  }
  return unavailable(`Unsupported tab-management tool: ${call.name}`)
}

/**
 * 把一次工具调用分发给所选标签页的 content script。
 * @param call - 要执行的工具调用。
 * @param sharePageContent - 用户的页面共享偏好：`'ask'` 读页面和动手前都问，`'auto'` 都不问。
 * @param budget - 按需注入 content script 之后要恢复的快照限制。
 * @param signal - bridge 生命周期；取消会拦下任何还没发出去的页面操作。
 * @param targetTab - background 亲和控制器选定的标签页。
 * @param targetStillAllowed - 异步审批/导航检查之后最后一道 fail-closed 守卫。
 * @param tabManagement - 标签页集合工具的访问模式和亲和回调。
 * @returns content script 的应答；没有可用标签页或
 *   content script 时返回一个稳定的错误。
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal?: AbortSignal,
  targetTab?: Pick<chrome.tabs.Tab, 'id' | 'url' | 'title'> & { windowId?: number },
  targetStillAllowed?: () => boolean,
  tabManagement: TabManagementContext = { unrestrictedAccess: false },
  /**
   * 按身份记着的、每张图的信息。
   *
   * 用参数传进来而不是 import，是为了让本模块还是个纯分发器：视觉流水线和它的缓存归
   * background 入口点。
   */
  vision?: VisionSink,
): Promise<ToolAnswer> {
  if (call.name === 'browser_open_tab') {
    return unavailable('browser_open_tab must be dispatched through the background open-tab path.')
  }
  if (call.name === 'browser_describe_image') {
    return unavailable('browser_describe_image must be dispatched through the background vision path.')
  }
  // 浏览器是 bridge 负责启动的；能走到这个分发器，说明它已经在跑了。在这儿作答（而不是当未知
  // 名字直接拒掉），工具契约才诚实：模型既然调了它，就该拿到一个真实结果。
  if (call.name === 'browser_launch') {
    return { ok: true, result: { text: 'The browser is already running and the extension is connected. Call browser_snapshot to see the page.' } }
  }
  if (isCancelled(call, signal)) return cancelled()
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }
  if (isTabManagementTool(call.name)) {
    return dispatchTabManagementTool(call, effectiveBudget, authorize, signal, tabManagement)
  }
  const tab = targetTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  if (targetStillAllowed?.() === false) return targetChanged()
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  if (!isInjectablePage(tab.url) && !TAB_NATIVE_TOOLS.has(call.name)) {
    return unavailable('The current page DOM is protected by the browser. Only snapshot metadata, navigate, back, forward, and reload are available on this page.')
  }
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  const approval = tabManagement.unrestrictedAccess
    ? undefined
    : approvalPromptForCall(call, sharePageContent, frames)
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (authorization !== 'approved') {
      return approvalFailure(approval, authorization)
    }
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    const refreshedApproval = approvalPromptForCall(call, sharePageContent, executionFrames)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('The page changed while approval was pending. Call browser_snapshot again before retrying.')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  if (!isInjectablePage(tab.url)) {
    return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
      ?? unavailable('The current page DOM is protected by the browser.')
  }
  try {
    return await dispatchOnce(
      tab.id,
      executionFrames,
      call,
      effectiveBudget,
      signal,
      targetStillAllowed,
      tabManagement.unrestrictedAccess || sharePageContent === 'auto',
      tabManagement.commitAction,
      tabManagement.rollbackActionCommit,
      vision,
    )
  } catch (error: unknown) {
    if (isCancelled(call, signal)) return cancelled()
    if (!contentScriptReceiverMissing(error)) {
      return unavailable(DISPATCH_UNANSWERED)
    }
    // 在扩展以 unpacked 方式装上或重载之前就开着的 tab，manifest 里声明的内容脚本不会追溯
    // 生效。就地恢复，用户就不用刷新、也就不用丢掉页面状态。
    try {
      await injectContentScript(tab.id)
    } catch {
      return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
        ?? unavailable('The content script could not be loaded on this page. Its DOM does not support browser operations.')
    }
    try {
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      if (approval !== undefined) {
        const refreshedApproval = approvalPromptForCall(call, sharePageContent, refreshedFrames)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('The page changed while the content script was loading. Call browser_snapshot again before retrying.')
        }
      }
      return await dispatchOnce(
        tab.id,
        refreshedFrames,
        call,
        effectiveBudget,
        signal,
        targetStillAllowed,
        tabManagement.unrestrictedAccess || sharePageContent === 'auto',
        tabManagement.commitAction,
        tabManagement.rollbackActionCommit,
        vision,
      )
    } catch {
      return unavailable('The content script did not answer after it was loaded. Call browser_snapshot again before retrying.')
    }
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  return undefined
}

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name !== 'browser_click' && call.name !== 'browser_type') return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (frame === undefined || snapshotted === undefined || snapshotted !== frameDocumentKey(frame)) {
    return unavailable('The element reference does not belong to the current document. Call browser_snapshot again for current frame and index values.')
  }
  return undefined
}

function sameApprovalBoundary(before: ApprovalPrompt, after: ApprovalPrompt): boolean {
  return before.kind === after.kind
    && before.action === after.action
    && before.origins.length === after.origins.length
    && before.origins.every((origin, index) => origin === after.origins[index])
}

function sameTargetDocument(call: ToolCall, before: TabFrame[], after: TabFrame[]): boolean {
  const frameId = requestedFrame(call.args)
  const beforeFrame = before.find((frame) => frame.frameId === frameId)
  const afterFrame = after.find((frame) => frame.frameId === frameId)
  return beforeFrame !== undefined
    && afterFrame !== undefined
    && frameDocumentKey(beforeFrame) === frameDocumentKey(afterFrame)
}

/** 解析模型给的 http(s) URL，建 tab / 导航用。 */
export function parseHttpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

async function removeCreatedTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // 这个 tab 可能已经被用户或别的工具关掉了。
  }
}

/**
 * 在新 tab 里打开一个 URL，文档就绪之后再可选地做一次快照。
 * affinity 的重新绑定由调用方通过 `bindCreatedTab` 负责。
 *
 * 先建一个空白 tab、装好就绪监听，然后再导航，这样一次很快的 `document_idle` 不可能在监听还
 * 不存在时就说自己就绪了。在 affinity 绑定之前取消，会把这个孤儿 tab 回滚掉；绑定之后这次打开
 * 就算已提交，调用超时也照样按成功上报。
 */
export async function dispatchOpenTab(
  call: ToolCall,
  windowId: number,
  sharePageContent: 'ask' | 'auto',
  budget: ContentBudget | undefined,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  bindCreatedTab: (tab: chrome.tabs.Tab) => boolean,
  targetStillAllowed: (tabId: number) => boolean,
  commitAction?: () => void,
  vision?: VisionSink,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  const parsed = parseHttpUrl(call.args.url)
  if (parsed === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
  }
  const active = call.args.active !== false

  const approval = approvalPromptForCall(call, sharePageContent, [])
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (authorization !== 'approved') return approvalFailure(approval, authorization)
  }

  let created: chrome.tabs.Tab
  try {
    // 这会儿还没有 URL：赶在 http(s) 导航之前先把就绪等待注册上。
    created = await chrome.tabs.create({ active, windowId })
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to open a new browser tab.',
      },
    }
  }
  if (created.id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'Chrome created a tab without an id.' } }
  }
  const tabId = created.id
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }

  const navigationWait = waitForNextDocumentReady(tabId, 0, undefined, signal)
  try {
    created = await chrome.tabs.update(tabId, { url: parsed.href })
  } catch (error: unknown) {
    navigationWait.cancel()
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to navigate the new browser tab.',
      },
    }
  }

  const ready = await navigationWait.ready
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }
  commitAction?.()
  if (!bindCreatedTab(created.id === undefined ? { ...created, id: tabId } : created)) {
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The new tab could not become the controlled browser target.' },
    }
  }

  // affinity 已经提交：之后再取消，也不能说这个 tab 从没打开过。
  resetTabSnapshot(tabId)
  if (!targetStillAllowed(tabId)) return targetChanged()

  const status = active
    ? `Opened a new tab at ${parsed.href}.`
    : `Opened a new background tab at ${parsed.href}.`
  if (!ready || isCancelled(call, signal)) {
    return {
      ok: true,
      result: {
        text: `${status} Call browser_snapshot again after the page loads.`,
      },
    }
  }

  try {
    const snapshot = await snapshotAfterNavigation(
      tabId,
      call,
      status,
      budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS },
      () => targetStillAllowed(tabId),
      vision,
    )
    if (snapshot !== undefined) return snapshot
  } catch {
    // 替换页面还读不了的时候，这次成功的打开照样保留。
  }
  return {
    ok: true,
    result: { text: `${status} Call browser_snapshot again after the page loads.` },
  }
}
