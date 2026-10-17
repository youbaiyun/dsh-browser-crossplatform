/**
 * 在桌面侧处理扩展的图片识别请求。
 *
 * 先向扩展要字节，因为只有它带着用户的登录状态；它完全取不到时——内容安全策略、host
 * 权限，或企业策略——就把 URL 发过来，改由桌面端用自己的网络栈去取。两条路径互补而不是
 * 冗余，帧里之所以带着 source、而不是永远只有一种来源，原因就在这里。
 *
 * 桌面端没有图片编解码器，所以它自己取回的字节一旦确认是图片、大小也合理，就原样透传。
 * 扩展已经规范化过的内容则以预缩放的形式到达。
 *
 * @module
 */

import type { ImageRecognitionRequest, ImageSource } from '@dsh-browser/protocol'
import type { VisionClient } from './vision.ts'

export type ImageRelayResult =
  | { ok: true; desc: string }
  | { ok: false; code: string; message: string }

/** 桌面端为单张图片从网络拉取字节数的上限。 */
const MAX_RELAY_BYTES = 12_000_000
const RELAY_TIMEOUT_MS = 15_000

export class ImageRelay {
  private readonly vision: VisionClient | undefined
  private readonly fetchImpl: typeof fetch

  constructor(vision: VisionClient | undefined, fetchImpl: typeof fetch = fetch) {
    this.vision = vision
    this.fetchImpl = fetchImpl
  }

  /** 有没有配置视觉模型，`hello.ok` 宣告的就是这个。 */
  get available(): boolean {
    return this.vision !== undefined
  }

  /**
   * 替扩展识别一张图片。
   *
   * @param request - 扩展收集到的页面上下文。
   * @param source - 规范化后的字节，或交给桌面端去取的一个 URL。
   * @returns 一行描述，或分类后的失败。
   */
  async recognize(request: ImageRecognitionRequest, source: ImageSource): Promise<ImageRelayResult> {
    const vision = this.vision
    if (vision === undefined) {
      return { ok: false, code: 'no-vision', message: 'no vision model is configured on the desktop' }
    }

    let bytes: { base64: string; mediaType: string }
    if (source.kind === 'bytes') {
      if (source.base64.length > MAX_RELAY_BYTES) {
        return { ok: false, code: 'too-large', message: `${String(source.base64.length)} base64 characters` }
      }
      bytes = { base64: source.base64, mediaType: source.mediaType }
    } else {
      const fetched = await this.fetchByUrl(source.url)
      if (!fetched.ok) return fetched
      bytes = fetched
    }

    const result = await vision.describe({
      base64: bytes.base64,
      mediaType: bytes.mediaType,
      context: {
        alt: request.alt,
        near: request.near,
        heading: request.heading,
        kind: request.kind,
        // 档位随请求一起走，中继出去的调用问的就是扩展自己那次调用会问的东西。
        // 这里是省略而不是设成 undefined，因为 `exactOptionalPropertyTypes`
        // 不接受后者。
        ...request.tier === undefined ? {} : { tier: request.tier },
      },
    })
    return result.ok
      ? { ok: true, desc: result.desc }
      : { ok: false, code: result.code, message: result.message }
  }

  /** 桌面端自己的尝试，用在扩展那次抓取没成功的时候。 */
  private async fetchByUrl(
    url: string,
  ): Promise<{ ok: true; base64: string; mediaType: string } | { ok: false; code: string; message: string }> {
    if (!/^https?:/i.test(url)) return { ok: false, code: 'bad-url', message: `unsupported scheme: ${url.slice(0, 40)}` }
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      return { ok: false, code: 'relay-network', message: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) return { ok: false, code: 'relay-http', message: String(response.status) }

    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!mediaType.startsWith('image/')) {
      return { ok: false, code: 'not-an-image', message: mediaType === '' ? 'no content-type' : mediaType }
    }

    let buffer: ArrayBuffer
    try {
      buffer = await response.arrayBuffer()
    } catch (error: unknown) {
      return { ok: false, code: 'relay-network', message: error instanceof Error ? error.message : String(error) }
    }
    if (buffer.byteLength > MAX_RELAY_BYTES) {
      return { ok: false, code: 'too-large', message: String(buffer.byteLength) }
    }
    return { ok: true, base64: Buffer.from(buffer).toString('base64'), mediaType }
  }
}
