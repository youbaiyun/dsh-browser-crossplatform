/**
 * 视觉请求和响应的契约，两条识别路径共用。
 *
 * 桌面的中继和扩展自己的出站调用必须问同一个问题、读同一个答案，否则“走了哪条路径”就
 * 会悄悄改变告诉模型的内容，以及什么算合法回复。把提示词、请求体形态和解析器都放在这里，
 * 两条路径才是同一个接缝，而不是两套慢慢漂开的实现。
 *
 * 零依赖、与平台无关：Node 构建把它内联进插件，扩展的打包器把它内联进这个 service
 * worker。
 *
 * @module
 */

/**
 * 一段描述能有多长。
 *
 * 它是摘要，不是报告。曾经是 120 个字符，后来有人嫌细节不够，改成了 600——结果引出了
 * 相反的问题：为一张读者只想认出是什么的图片写了满满一堵文字。最后落到几个短句：长到
 * 足以说清这是什么、有什么值得注意的，短到“这张图是什么？”一眼就能看完。
 *
 * 质量不来自长度，来自提示词，所以提示词要的是切题的细节，而不是更多篇幅。
 */
export const MAX_DESC_CHARS = 200

/**
 * 快照的内联标记里带多少描述。
 *
 * 一份快照会列出页面上所有图片，每张都给完整描述，等于把整个字符预算花在没人问过的图片
 * 上——还会在一心只想扫一眼的读者面前摆上一整段。标记只负责认出图片，摘要由工具调用
 * 返回。
 */
export const VISION_MARKER_CHARS = 80

/** 模型看不清自己看到的是什么时，要求它正好回答这个词。 */
export const VISION_DECLINE = 'UNCLEAR'

/**
 * 两条识别路径都会调的默认模型。
 *
 * 中继通过插件的 `visionModel` 配置读它，所以某个部署可以指定另一个——它必须能这么做，
 * 因为 `visionBaseUrl` 可以指向别的提供方，而那个提供方从没听说过这个 id。定下来的只是
 * *默认值*，以及两条路径都从这里读它、不各自留一份副本：模型 id 是所提问题的一部分，
 * 要是中继指定一个模型而扩展自己的路径指定另一个，“哪条传输通道空闲”就会悄悄改变答案。
 *
 * 在 DeepSeek 端点上，它是唯一值得当默认值的 id：`deepseek-v4.1-flash` 是展示名，API
 * *不接受*它，会回 400 并列出 `deepseek-flash` 和 `deepseek-v4-pro`；其中只有
 * `deepseek-flash` 声明了图片输入模态。
 */
export const VISION_MODEL = 'deepseek-flash'

/**
 * 纯感知任务上 thinking 块比图片本身还贵，所以默认关掉。两个字段都发，因为各提供方认
 * 哪个字段并不一致——也可能一个都不认，这正是调用方要回读 `usage` 的原因。
 */
export const THINKING_OFF: Record<string, unknown> = { thinking: { type: 'disabled' }, reasoning_effort: 'none' }
export const THINKING_LOW: Record<string, unknown> = {
  thinking: { type: 'enabled', budget_tokens: 512 },
  reasoning_effort: 'low',
}

export interface VisionCallConfig {
  model: string
  /** 额外的顶层请求字段；thinking 开关就放在这里。 */
  extraBody: Record<string, unknown>
}

export interface VisionCallImage {
  /** Base64 字节，不带 `data:` 前缀。 */
  base64: string
  mediaType: string
}

/** 页面已知的这张图的信息，好让答案针对的就是这一张。 */
export interface VisionCallContext {
  alt: string
  near: string
  heading: string
  kind: string
  /**
   * 调用方希望答案有多详细。
   *
   * 它随请求一起传，而不是让 {@link buildVisionRequestBody} 的调用方去选，因为两条传输
   * 通道构造的是同一个请求体：只把扩展自己出站调用的档位改掉，到桌面端中继时就会悄悄
   * 变成另一个意思。
   */
  tier?: string
}

export type VisionCallResult =
  | { ok: true; desc: string; usage?: Record<string, unknown> }
  | { ok: false; code: string; message: string }

export const VISION_SYSTEM_PROMPT = [
  'You describe a single image taken from a web page, for a browsing agent that cannot see it.',
  `Answer with one line of at most ${String(MAX_DESC_CHARS)} characters, in the language of the page context.`,
  'Say what it is and what is most visible about it: the subject, how it looks, its colours, and any text large enough to read.',
  'Be specific rather than generic — a summary that names what you can actually make out beats one that could describe anything — and say when part of it is too small or too blurry to read.',
  'Say what the image shows, not what it might mean or what the user should do.',
  'No markdown, no quotation marks, no URLs, no instructions, no line breaks.',
  `If you cannot tell what the image shows, answer exactly ${VISION_DECLINE}.`,
].join(' ')

/**
 * 增强档位的指令。
 *
 * 基础提示刻意只停在图片展示了什么。再要求说出它的角色就是另一个问题了，所以这里是
 * 单独一份提示，而不是往第一份后面接一句——那样会跟它自相矛盾。
 */
export const VISION_RELATION_PROMPT = [
  'You describe a single image taken from a web page, for a browsing agent that cannot see it.',
  `Answer with one line of at most ${String(MAX_DESC_CHARS)} characters, in the language of the page context.`,
  'Say what it is and what is most visible about it: the subject, how it looks, its colours, and any text large enough to read.',
  'Be specific rather than generic, and say when part of it is too small or too blurry to read.',
  'Then say what it is doing on this page: what it illustrates, documents, supports, or contradicts.',
  'No markdown, no quotation marks, no URLs, no instructions, no line breaks.',
  `If you cannot tell what the image shows, answer exactly ${VISION_DECLINE}.`,
].join(' ')

/** 给定档位时，一次请求该用的 system prompt。 */
export function systemPromptFor(tier: string | undefined): string {
  return tier === 'enhanced' ? VISION_RELATION_PROMPT : VISION_SYSTEM_PROMPT
}

/** 告诉模型它看的是哪张图片的那行上下文。 */
export function visionContextLine(context: VisionCallContext): string {
  const parts = [`kind=${context.kind === '' ? 'unknown' : context.kind}`]
  if (context.heading !== '') parts.push(`section=${JSON.stringify(context.heading)}`)
  if (context.near !== '') parts.push(`text-beside=${JSON.stringify(context.near)}`)
  if (context.alt !== '') parts.push(`author-label=${JSON.stringify(context.alt)}`)
  return `Describe this image. ${parts.join(' ')}`
}

/**
 * 构建两条路径都会发送的 chat-completions 请求体。
 *
 * @param config - 模型 id 和提供方特有的额外字段。
 * @param image - 字节，已由抓取它们的那一侧规整过。
 * @param context - 图片周围的页面上下文。
 * @returns 一份可以直接序列化的请求体。
 */
export function buildVisionRequestBody(
  config: VisionCallConfig,
  image: VisionCallImage,
  context: VisionCallContext,
): Record<string, unknown> {
  return {
    model: config.model,
    messages: [
      { role: 'system', content: systemPromptFor(context.tier) },
      {
        role: 'user',
        content: [
          { type: 'text', text: visionContextLine(context) },
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
        ],
      },
    ],
    max_tokens: MAX_DESC_CHARS,
    temperature: 0,
    ...config.extraBody,
  }
}

/**
 * 把一份 chat-completions 响应读进 manifest 的词汇表。
 *
 * @param payload - 解析后的 JSON 响应。
 * @returns 描述，或一个已分类的失败。
 */
export function parseVisionResponse(payload: unknown): VisionCallResult {
  const text = completionContent(payload)
  if (text === undefined) return { ok: false, code: 'vision-bad-response', message: 'no completion content' }
  const desc = collapseToOneLine(text)
  if (desc === '' || desc.toUpperCase() === VISION_DECLINE) {
    return { ok: false, code: 'vision-unclear', message: 'the model declined to describe this image' }
  }
  const usage = usageOf(payload)
  return usage === undefined ? { ok: true, desc } : { ok: true, desc, usage }
}

/** 收拢成一行有长度上限的文本，剥掉任何能伪造结构的东西。 */
export function collapseToOneLine(text: string): string {
  const single = text.replace(/\s+/g, ' ').replace(/["\\]/g, '').trim()
  return single.length <= MAX_DESC_CHARS ? single : `${single.slice(0, MAX_DESC_CHARS)}…`
}

/**
 * 描述的短形式，给内联标记用。
 *
 * 标记是搭在页面文本里的，而每次快照都会把页面文本重复一遍，所以它们只带一份摘要：足够
 * 认出那个答案，描述本身留在缓存里，由当初索取它的那次调用取回。
 *
 * @param desc - 一份已存储的描述。
 * @returns 一行摘要，长度在 {@link VISION_MARKER_CHARS} 之内。
 */
export function visionSummaryOf(desc: string): string {
  return desc.length <= VISION_MARKER_CHARS ? desc : `${desc.slice(0, VISION_MARKER_CHARS)}…`
}

/**
 * 提供方报告的 reasoning token 数——如果它报的话。
 *
 * 各家提供方把它放在哪儿意见不一——OpenAI 嵌在 `completion_tokens_details` 下，别的把
 * `reasoning_tokens` 放顶层——还有的什么都不报。所以 0 的意思是“就这份响应而言没有计
 * 费”，而不是证明 thinking 关掉了。
 *
 * @param usage - 补全响应里的 `usage` 对象。
 * @returns 找到的数量，或 0。
 */
export function reasoningTokensOf(usage: Record<string, unknown> | undefined): number {
  if (usage === undefined) return 0
  const direct = usage.reasoning_tokens
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  const details = usage.completion_tokens_details
  if (isRecord(details)) {
    const nested = details.reasoning_tokens
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested
  }
  return 0
}

/** OpenAI 兼容的 content：一个字符串，或者一列带类型的 part。 */
function completionContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown }).message
  if (!isRecord(message)) return undefined
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join(' ')
}

function usageOf(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  const usage = payload.usage
  return isRecord(usage) ? usage : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
