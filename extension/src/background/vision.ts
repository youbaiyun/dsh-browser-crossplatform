/**
 * 识别接缝，以及它背后的两条传输路径。
 *
 * 两条路径问的是同一个问题，读的也是同一个答案，因为 prompt、请求体和解析器都在共享的
 * protocol 契约里。所以走哪条只取决于部署——桌面端配没配 vision 模型——绝不意味着模型听到的
 * 东西有什么不同。
 *
 * - `BridgeRecognizer` 走桌面端中转。它不用动 manifest（扩展的 CSP 本来就允许回环地址），
 *   还能直接用桌面端手里已有的凭据。
 * - `DirectRecognizer` 自己打端点。manifest 放开了 `https:` 和 `http:`，所以端点主机同样
 *   不用动 manifest。
 *
 * 两者都不会把一张“谁能读”还没定下来的图片发出去：扩展读得到字节就发字节（它带着登录状态），
 * 只有退回中转时才发 URL（桌面端的网络栈不受扩展主机权限约束）。
 *
 * @module
 */

import type { ClientFrame, ImageRecognitionRequest, ImageSource, ServerFrame } from '@dsh-browser/protocol'
import {
  THINKING_OFF,
  buildVisionRequestBody,
  parseVisionResponse,
  reasoningTokensOf,
  visionSummaryOf,
} from '@dsh-browser/protocol'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import type { VisionTier } from '../settings.ts'
import type { ImageCache } from './image-cache.ts'
import { compareDescription, type CompareResult } from './vision-compare.ts'

/** 单次识别等多久就放弃。 */
export const VISION_TIMEOUT_MS = 60_000

/** 同时跑几个识别。bridge 那边自己的上限是四。 */
export const VISION_CONCURRENCY = 2

/** 要识别什么，以及页面已经说了什么。 */
export interface RecognitionTarget {
  /** 稳定标识；同时也是缓存键，所以同一个 logo 只描述一次。 */
  identity: string
  alt: string
  near: string
  heading: string
  kind: string
}

/** 一次识别尝试的结果。 */
export type RecognitionOutcome =
  | {
    ok: true
    desc: string
    comparison: CompareResult
    via: 'desktop' | 'direct'
    /** provider 报出来的 reasoning tokens；没报就是 0。 */
    reasoningTokens: number
    /**
     * 明明这次请求关了 thinking，provider 却报出了 reasoning tokens，此时为 true。
     * 设计文档 §3.2 说了，兼容端点可能默默忽略这两个开关，而响应是唯一的证据。
     */
    thinkingIgnored: boolean
  }
  | { ok: false; code: string; message: string; permanent: boolean }

/** 一种把图片变成一行文字的传输方式。 */
export interface ImageRecognizer {
  /**
   * @param request - 这张图的页面上下文。
   * @param source - 字节在哪儿，或者能上哪儿取。
   * @param signal - 取消等待（远端自己那份活儿可能照做不误）。
   * @returns 描述文本，或一个已经分好类的失败。
   */
  describe(
    request: ImageRecognitionRequest,
    source: ImageSource,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; desc: string; reasoningTokens?: number }
    | { ok: false; code: string; message: string; permanent: boolean }
  >
}

/**
 * 桌面端报回来的某个失败，是不是意味着这张图别再问了。
 *
 * `vision-unclear` 有意算作永久：模型问过了，答的是自己判断不了，再问一遍只会再花一次请求
 * 换同一个答案。被否掉的图片报成不可用，而不是一路重试到打转。
 *
 * @param code - bridge 的错误码。
 * @returns 重试对本次会话没帮助时为 true。
 */
export function isPermanentVisionCode(code: string): boolean {
  return code === 'vision-unclear'
    || code === 'vision-unavailable'
    || code === 'image-unreadable'
    || code === 'image-too-large'
}

/** recognizer 最后定案的结果形状。 */
type RecognizerResult =
  | { ok: true; desc: string; reasoningTokens?: number }
  | { ok: false; code: string; message: string; permanent: boolean }

/** 每个在途识别配一个 settle 函数。 */
type Settle = (result: RecognizerResult) => void

/**
 * 走桌面端 bridge 的识别。
 *
 * socket 归 background 组装层，所以这个类只拿到它的 `send`，路由回来的帧也由组装层喂进来。
 * 它自己手里只有那张关联表。
 */
export class BridgeRecognizer implements ImageRecognizer {
  private readonly pending = new Map<string, Settle>()
  private readonly send: (frame: ClientFrame) => boolean
  private readonly timeoutMs: number

  /**
   * @param send - bridge 客户端的帧发送函数（连接断了返回 false）。
   * @param timeoutMs - 每个请求的预算。
   */
  constructor(send: (frame: ClientFrame) => boolean, timeoutMs: number = VISION_TIMEOUT_MS) {
    this.send = send
    this.timeoutMs = timeoutMs
  }

  /** 还在等答案的识别数。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 收一个 `image.result` 帧，前提是它属于某个在途请求。
   * @param frame - 一个服务器帧。
   * @returns 该帧在这里被消费掉时为 true。
   */
  handleFrame(frame: ServerFrame): boolean {
    if (frame.t !== 'image.result') return false
    const settle = this.pending.get(frame.id)
    if (settle === undefined) return false
    this.pending.delete(frame.id)
    if (frame.ok) {
      settle({ ok: true, desc: frame.desc })
    } else {
      settle({
        ok: false,
        code: frame.error.code,
        message: frame.error.message,
        permanent: isPermanentVisionCode(frame.error.code),
      })
    }
    return true
  }

  /**
   * 让每个在等的请求失败，比如 socket 掉线的时候。
   * @param code - 给它们定案用的失败码。
   * @param permanent - 调用方要不要就此不再问。
   */
  failAll(code: string, permanent: boolean): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const settle of waiting) settle({ ok: false, code, message: code, permanent })
  }

  /** @inheritdoc */
  async describe(
    request: ImageRecognitionRequest,
    source: ImageSource,
    signal: AbortSignal,
  ): Promise<RecognizerResult> {
    // 发送前就查，不能只顾发送后：调用方可能在这段等并发槽位的时间里已经放弃了，再派发就
    // 等于把用户的图片传给 provider，换一个没人在等的答案。`DirectRecognizer` 出于同样的
    // 理由也做了这道防护；这条路更需要它，因为一个排着队的调用走到这儿之前可能已经等了很久。
    if (signal.aborted) {
      return { ok: false, code: 'image-cancelled', message: 'the call was cancelled', permanent: false }
    }
    const id = crypto.randomUUID()
    const dispatched = this.send({ t: 'image.call', id, request, source })
    if (!dispatched) {
      return { ok: false, code: 'bridge-closed', message: 'no bridge connection', permanent: false }
    }
    return await new Promise<RecognizerResult>((resolve) => {
      const finish = (result: RecognizerResult): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        resolve(result)
      }
      const onAbort = (): void => {
        // protocol 里没有 image.cancel 帧，桌面端可能照样把这次调用做完并计费；这里停下的
        // 只是等待。
        finish({ ok: false, code: 'image-cancelled', message: 'cancelled before the desktop answered', permanent: false })
      }
      const timer = setTimeout(() => {
        finish({ ok: false, code: 'image-timeout', message: `no answer within ${String(this.timeoutMs)}ms`, permanent: false })
      }, this.timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, finish)
      if (signal.aborted) onAbort()
    })
  }
}

/**
 * 配上端点之后，该打的 chat-completions URL。
 *
 * 两条传输路径读的是同一个设置，就得按同样的方式读：桌面端自己的客户端会补上这段路径，而一个
 * 粘了完整 URL 进来的用户不该把请求发到 `…/chat/completions/chat/completions` 上去。
 *
 * @param endpoint - 配好的基础 URL，或完整路径。
 * @returns 要 POST 的 URL。
 */
export function chatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

/** 扩展自己发出去的调用用的端点、凭据和模型。 */
export interface DirectVisionConfig {
  endpoint: string
  model: string
  apiKey: string
  /** 附加的请求字段；默认 {@link THINKING_OFF}。 */
  extraBody?: Record<string, unknown>
}

/**
 * 直接打端点的识别。
 *
 * 这条路要图片字节：共享契约会构造 `data:` URL，所以只有 URL 的来源得先把字节取回来，而
 * 这件事是 coordinator 干的。
 */
export class DirectRecognizer implements ImageRecognizer {
  private readonly config: () => DirectVisionConfig | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  /**
   * @param config - 读当前端点设置（缺失 = 没配）。
   * @param fetchImpl - fetch 实现，为了测试可注入。
   * @param timeoutMs - 每个请求的预算。
   */
  constructor(
    config: () => DirectVisionConfig | undefined,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = VISION_TIMEOUT_MS,
  ) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  /** @inheritdoc */
  async describe(
    request: ImageRecognitionRequest,
    source: ImageSource,
    signal: AbortSignal,
  ): Promise<RecognizerResult> {
    const config = this.config()
    if (config === undefined || config.endpoint === '' || config.model === '') {
      return { ok: false, code: 'vision-unavailable', message: 'no vision endpoint configured', permanent: true }
    }
    if (source.kind !== 'bytes') {
      return { ok: false, code: 'vision-needs-bytes', message: 'the direct path sends bytes, not URLs', permanent: false }
    }
    const body = buildVisionRequestBody(
      { model: config.model, extraBody: config.extraBody ?? THINKING_OFF },
      { base64: source.base64, mediaType: source.mediaType },
      { alt: request.alt, near: request.near, heading: request.heading, kind: request.kind, tier: request.tier },
    )
    // 两种取消共用一个 controller：`AbortSignal.any`/`AbortSignal.timeout` 出来得比较晚，
    // 而 service worker 并不是这里唯一的运行环境（测试是第二个），所以这个组合是手工搭的。
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    // 执行到这儿时 signal 可能已经中止了：`run()` 会在 `acquire()` 里排在另一张图后面等，
    // 而调用方说不定早放弃了。少这个检查，监听器就永远不触发，请求照样发出去——把用户的图片
    // 发给 provider，换一个没人要的答案。
    if (signal.aborted) onAbort()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let payload: unknown
    try {
      const response = await this.fetchImpl(chatCompletionsUrl(config.endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        return { ok: false, code: 'vision-failed', message: `HTTP ${String(response.status)}`, permanent: false }
      }
      payload = await response.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (signal.aborted) return { ok: false, code: 'image-cancelled', message, permanent: false }
      // 扩展页面只能访问 CSP 允许的主机。把这点讲出来，"Failed to fetch" 最可能的成因就成了
      // 用户能据以行动的信息，而不是一条读着像网络断了的消息。
      return {
        ok: false,
        code: 'vision-failed',
        message,
        permanent: false,
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const parsed = parseVisionResponse(payload)
    if (!parsed.ok) {
      return { ok: false, code: parsed.code, message: parsed.message, permanent: isPermanentVisionCode(parsed.code) }
    }
    // 这次请求确实关了 thinking，但 provider 可能默默忽略那两个开关；响应里的 reasoning
    // tokens 就是它真忽略了的唯一证据，所以这些数字跟着答案一起往上传递，而不是默认当没有。
    return { ok: true, desc: parsed.desc, reasoningTokens: reasoningTokensOf(parsed.usage) }
  }
}

/**
 * 包装之后的描述文本预算。
 *
 * envelope 是两遍安全提示加两个带 nonce 的标签，光这一部分就约 400 个字符，而描述还要再加
 * `MAX_DESC_CHARS`。预算低于两者之和，描述不会被压缩，而是被整个删掉，只给模型留下一个空
 * 边界和一条截断说明。400 字符的预算干的就是这个。
 */
const DESCRIPTION_TEXT_BUDGET = 700

/**
 * 一次识别结果给模型看的文本。
 *
 * 描述要按不可信内容包起来，这不是走过场：它是模型对一张本对话里没人写过的图片的解读，而图片
 * 里可以带上模型会逐字转抄的文字。一张图就是这么变成一条指令的，所以描述和页面文本待在同一个
 * 边界之内。交叉核对那一行是我们自己写的，它说清了其余内容有多少可信——包括根本没法核对时
 * 就明说这一点。
 *
 * @param index - 图片在清单里的索引。
 * @param outcome - 识别结果。
 * @param byteFailure - 扩展读不到字节的原因（读不到时才有）。
 * @returns 工具结果文本。
 */
export function describeOutcomeText(
  index: number,
  outcome: RecognitionOutcome,
  byteFailure?: string,
): string {
  if (!outcome.ok) {
    const retry = outcome.permanent
      ? 'It will not be asked about again in this session.'
      : 'Trying again later may succeed.'
    return `Image [${String(index)}] could not be described: ${outcome.code} — ${outcome.message} ${retry}`
  }
  const lines = [`Image [${String(index)}] (via ${outcome.via}): ${wrapUntrustedContent(outcome.desc, DESCRIPTION_TEXT_BUDGET)}`]
  if (outcome.thinkingIgnored) {
    lines.push(`Note: the provider billed ${String(outcome.reasoningTokens)} reasoning tokens although thinking was requested off.`)
  }
  if (outcome.comparison.verdict === 'conflict') {
    const details = outcome.comparison.conflicts.map((entry) => entry.detail).join('; ')
    lines.push(`Cross-check against the page text: CONFLICT — ${details}. Do not act on this description before the user confirms it.`)
  } else if (outcome.comparison.verdict === 'uncertain') {
    // 备注报的是观察到什么，不是判定成什么：用词重叠只能说明描述没照抄页面的词，不等于两边
    // 意见相左；而一个连意见一致时都会响的警告，慢慢就没人看了。
    const note = outcome.comparison.note === undefined ? '' : ` — ${outcome.comparison.note}`
    lines.push(outcome.comparison.basis === 'skipped'
      ? 'Cross-check against the page text: skipped by the low tier.'
      : outcome.comparison.basis === 'none'
        ? 'Cross-check against the page text: not possible, the page says nothing about this image.'
        : `Cross-check against the page text: nothing conclusive${note}.`)
  } else {
    lines.push('Cross-check against the page text: consistent.')
  }
  if (byteFailure !== undefined) {
    lines.push(`(The extension could not read these bytes — ${byteFailure} — so the desktop fetched them instead.)`)
  }
  return lines.join('\n')
}

/**
 * 工具 dispatcher 报给 vision 流水线的东西。
 *
 * 用一个对象，不用两个回调：两个答案都出自同一个地方——某次页面操作产出的文本——拆成两条线
 * 传，只会让 dispatcher 的参数列表为同一个理由再胖一圈。
 */
export interface VisionSink {
  /** 按 identity 给一张图渲染状态；undefined 就把标记留着。 */
  states(identity: string): string | undefined
  /**
   * 这个答案带来的页面文本，供跨模态检查用。
   *
   * 调用方传进来的文本已经把标记摘掉了：填充过的标记里装的就是描述，不摘的话，一份提到某个
   * 数字的描述会拿自己跟自己比。
   */
  sawPageText(text: string): void
}

/** coordinator 要从 background 组装层拿到的一切。 */
export interface VisionDeps {
  cache: ImageCache
  send: (frame: ClientFrame) => boolean
  /** 桌面端说没说自己能识别图片（`policy.imageRecognition`）。 */
  canRelay: () => boolean
  /** 直连路径的设置读取器；用户没配就是缺的。 */
  directConfig?: () => DirectVisionConfig | undefined
  /** 页面的可见文本，供跨模态检查用。 */
  pageText: () => string
  /** 一张图的字节，调用方手里已经有时才传。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 把图片变成描述：一个缓存、两条传输路径、一次校验。
 *
 * 只有 coordinator 决定走*哪条*路径，所以调用方不可能自己挑一条、把属于这个答案的跨模态检查
 * 跳过去。
 */
export class VisionCoordinator {
  private readonly cache: ImageCache
  private readonly relay: BridgeRecognizer
  private readonly direct: DirectRecognizer | undefined
  private readonly directConfig: (() => DirectVisionConfig | undefined) | undefined
  private readonly canRelay: () => boolean
  private readonly pageText: () => string
  private readonly inFlight = new Map<string, Promise<RecognitionOutcome>>()
  private readonly waiting: Array<() => void> = []
  private active = 0
  private readonly limit: number

  /**
   * @param deps - 缓存、传输路径和页面文本。
   * @param limit - 同时跑几个识别。
   */
  constructor(deps: VisionDeps, limit: number = VISION_CONCURRENCY) {
    this.cache = deps.cache
    this.relay = new BridgeRecognizer(deps.send, deps.timeoutMs ?? VISION_TIMEOUT_MS)
    this.directConfig = deps.directConfig
    this.direct = deps.directConfig === undefined
      ? undefined
      : new DirectRecognizer(deps.directConfig, deps.fetchImpl ?? fetch, deps.timeoutMs ?? VISION_TIMEOUT_MS)
    this.canRelay = deps.canRelay
    this.pageText = deps.pageText
    this.limit = limit
  }

  /** 归这个 coordinator 管的帧；组装层会先把它们路由过来。 */
  handleFrame(frame: ServerFrame): boolean {
    return this.relay.handleFrame(frame)
  }

  /**
   * 给每个在等桌面端的识别定案，因为 socket 已经没了。
   *
   * 连接断了就调它。没有它，一次在途的中转往返会白等满整个超时，去等一个不可能来的答案：调用方
   * 的 abort signal 通常能救它，但一个从不中止的调用方会让模型攥着 `pending` 标记整整一分钟。
   * 现在定案不花什么代价，报出来的内容又正好是 socket 掉了所意味着的事。
   *
   * @param code - 给它们定案用的失败码；它同时充当消息文本。
   */
  relayLost(code: string): void {
    this.relay.failAll(code, false)
  }

  /** 记住的描述，还有失败记录。 */
  stats(): ReturnType<ImageCache['stats']> {
    return this.cache.stats()
  }

  /** 为一张图记住的内容，好渲染回快照里。 */
  descriptionOf(identity: string): string | undefined {
    return this.cache.get(identity)?.desc
  }

  /**
   * 给一张图在页面文本里出现的位置渲染状态。
   *
   * 每个分支都给了模型一点能拿来行动的东西。正在识别的图报 `pending`，而不是不吭声，因为
   * “还没有”和“这儿没图”绝不能长得一样；失败的图带上原因，因为光一句 `unavailable` 给不了
   * 模型任何有用的信息。
   *
   * @param identity - 图片标识，来自快照的 identity 映射。
   * @returns 状态文本；这个 identity 在这里不认识时为 undefined。
   */
  stateFor(identity: string): string | undefined {
    const cached = this.cache.get(identity)
    // 标记里放的是摘要，不是描述：快照会把每个标记重复一遍，完整文本等于把页面的字符预算花在
    // 没人问起的图片上。想要完整内容，再问一次就从缓存里取回来了。
    if (cached !== undefined) return visionSummaryOf(cached.desc)
    if (this.inFlight.has(identity)) return 'pending'
    const failure = this.cache.failureOf(identity)
    if (failure !== undefined) return `unavailable:${failure}`
    return undefined
  }

  /**
   * 现在有没有哪条路径能给出答案。
   *
   * 排队之前先问一下，免得没配置的桌面端把页面上每张图的失败记录都塞进缓存。
   *
   * @returns 至少有一种传输方式可用时为 true。
   */
  canRecognize(): boolean {
    if (this.canRelay()) return true
    const config = this.directConfig?.()
    return config !== undefined && config.endpoint !== '' && config.model !== ''
  }

  /**
   * 描述一张图片，更早的答案能复用就复用。
   *
   * @param target - 图片和它的页面上下文。
   * @param source - 字节（首选），或者交给中转去抓的 URL。
   * @param signal - 取消等待。
   * @returns 带跨模态判定的描述，或一个失败。
   */
  async describe(
    target: RecognitionTarget,
    source: ImageSource,
    signal: AbortSignal,
    tier: VisionTier = 'standard',
  ): Promise<RecognitionOutcome> {
    const cached = this.cache.get(target.identity)
    if (cached !== undefined) {
      return {
        ok: true,
        desc: cached.desc,
        comparison: this.compare(cached.desc, target, tier),
        via: cached.via === 'direct' ? 'direct' : 'desktop',
        // 从缓存里翻出来的答案没有新的 provider 用量可报。
        reasoningTokens: 0,
        thinkingIgnored: false,
      }
    }
    if (!this.cache.shouldAttempt(target.identity)) {
      return { ok: false, code: 'vision-skipped', message: 'this image cannot be read in this session', permanent: true }
    }
    const existing = this.inFlight.get(target.identity)
    if (existing !== undefined) return await existing
    const work = this.run(target, source, signal, tier)
    this.inFlight.set(target.identity, work)
    try {
      return await work
    } finally {
      this.inFlight.delete(target.identity)
    }
  }

  private async run(
    target: RecognitionTarget,
    source: ImageSource,
    signal: AbortSignal,
    tier: VisionTier,
  ): Promise<RecognitionOutcome> {
    await this.acquire()
    try {
      const request: ImageRecognitionRequest = {
        identity: target.identity,
        alt: target.alt,
        near: target.near,
        heading: target.heading,
        kind: target.kind,
        tier,
      }
      const relay = this.canRelay()
      const recognizer: ImageRecognizer | undefined = relay ? this.relay : this.direct
      if (recognizer === undefined) {
        return { ok: false, code: 'vision-unavailable', message: 'no vision model is configured', permanent: true }
      }
      const result = await recognizer.describe(request, source, signal)
      if (!result.ok) {
        this.cache.noteFailure(target.identity, result.permanent, result.code)
        return result
      }
      const via: 'desktop' | 'direct' = relay ? 'desktop' : 'direct'
      this.cache.set(target.identity, result.desc, via)
      const reasoningTokens = result.reasoningTokens ?? 0
      return {
        ok: true,
        desc: result.desc,
        comparison: this.compare(result.desc, target, tier),
        via,
        reasoningTokens,
        thinkingIgnored: reasoningTokens > 0,
      }
    } finally {
      this.release()
    }
  }

  private compare(desc: string, target: RecognitionTarget, tier: VisionTier): CompareResult {
    // low 档的价值就在便宜：它只回答图里有什么，不为交叉核对付钱。直说这一点，好过为一次
    // 根本没跑的检查返回 `consistent` 判定。
    if (tier === 'low') return { verdict: 'uncertain', conflicts: [], basis: 'skipped', overlap: 0 }
    return compareDescription(desc, { alt: target.alt, near: target.near, heading: target.heading }, this.pageText())
  }

  /** 拿一个并发槽位，拿不到就等人交过来。 */
  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    // `release` 已经把槽位交到这个调用方手上了；计数不用动。
  }

  /** 把槽位交给下一个等的，没人等就还回去。 */
  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active -= 1
      return
    }
    next()
  }
}
