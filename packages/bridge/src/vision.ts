/**
 * 桌面端替扩展发出的多模态调用。
 *
 * 只有桌面端能在不把模型凭据放进浏览器 profile 的前提下拿着它，也只有桌面端能经本机自己
 * 的代理、VPN 或客户端证书访问网络。本模块只是传输层：提示词、请求体和响应解析都和扩展
 * 自己的出站路径共用，所以“由哪一侧调模型”既不影响问什么，也不影响什么算作答。
 *
 * @module
 */

import {
  buildVisionRequestBody,
  parseVisionResponse,
  reasoningTokensOf,
  type VisionCallConfig,
  type VisionCallContext,
  type VisionCallImage,
  type VisionCallResult,
} from '@dsh-browser/protocol'

export type { VisionCallContext, VisionCallResult }

/** 一张 1×1 的透明 PNG：视觉端点愿意接受的最小东西。 */
export const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 一次探测了解到的该部署成本控制情况。 */
export interface VisionProbe {
  ok: boolean
  /** 响应上报的推理 token 数；没有或未上报时为 0。 */
  reasoningTokens: number
  message: string
}

export interface VisionConfig extends VisionCallConfig {
  /** chat-completions 的基础 URL。 */
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

export interface VisionRequest extends VisionCallImage {
  context: VisionCallContext
}

export type VisionResult = VisionCallResult

export class VisionClient {
  private readonly config: VisionConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: VisionConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  /**
   * 描述一张图片。
   *
   * @param request - 规范化后的字节，外加它们周围的页面上下文。
   * @returns 一行描述，或分类后的失败。
   */
  async describe(request: VisionRequest): Promise<VisionResult> {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(buildVisionRequestBody(this.config, request, request.context)),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error: unknown) {
      return { ok: false, code: 'vision-network', message: error instanceof Error ? error.message : String(error) }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, code: 'vision-http', message: `${String(response.status)} ${detail.slice(0, 200)}` }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      return { ok: false, code: 'vision-bad-response', message: error instanceof Error ? error.message : String(error) }
    }
    return parseVisionResponse(payload)
  }

  /**
   * 发一次最小的请求，把计费读回来。
   *
   * thinking 开关可能被悄悄忽略——请求成功了，答案看着也没问题，而每张图片的花费是它本该
   * 有的好几倍。唯一能知道的办法就是去看 `usage`，所以这里把尽可能小的图片发一次，并报告
   * 拿回来的东西。
   *
   * @returns 提供方报告的内容，或这次探测跑不起来的原因。
   */
  async probe(): Promise<VisionProbe> {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(buildVisionRequestBody(
          this.config,
          { base64: PROBE_IMAGE_BASE64, mediaType: 'image/png' },
          { alt: '', near: '', heading: '', kind: 'icon' },
        )),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error: unknown) {
      return { ok: false, reasoningTokens: 0, message: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) return { ok: false, reasoningTokens: 0, message: `HTTP ${String(response.status)}` }
    try {
      const payload = await response.json() as { usage?: Record<string, unknown> }
      return { ok: true, reasoningTokens: reasoningTokensOf(payload.usage), message: 'ok' }
    } catch (error: unknown) {
      return { ok: false, reasoningTokens: 0, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
