/**
 * 在扩展这一侧把一张图片的字节取到手。
 *
 * 先问扩展，是因为只有它带着用户的登录状态：
 * 要登录才看得见的商品图、私有信息流里的头像、需要认证的仪表盘图表，
 * 在这儿都读得到，换成别人一律被拒。`host_permissions` 已经覆盖 `http(s)://*`，
 * 所以这里用普通 `fetch` 就行，不必走限定标签页的读取。
 *
 * 这里不解码、不缩放、也不识别：要么给出字节，要么说清楚为什么拿不到。
 * 失败是一个值，绝不悄悄跳过——
 * 一张被说过存在、从此再无下文的图片，
 * 比一张明说读不了的图片更糟。
 *
 * @module
 */

import type { ImageSource } from '@dsh-browser/protocol'

/** 可以直接作为 `bytes` 图片源传输的图片字节。 */
export interface ImageBytes {
  mediaType: string
  base64: string
}

/** 字节不可用的原因。 */
export type ImageFetchCode =
  /** 响应（或 data URL）超出了传输预算。 */
  | 'too-large'
  /** 本上下文读不了的 URL 协议（比如页面创建的 `blob:`）。 */
  | 'unsupported-url'
  /** 请求失败：网络、CORS、CSP，或者非 2xx 状态码。 */
  | 'fetch-failed'
  /** 请求成功，但一个字节都没返回。 */
  | 'empty'

/** 失败值：给调用方分类用的代码，以及上报用的消息。 */
export interface ImageFetchFailure {
  code: ImageFetchCode
  message: string
  /**
   * 本会话里重试同一个 URL 也好不了时为 true：本上下文读不了的协议，
   * 或者超出预算的响应体。调用方靠它停下对一张永久不可用图片的反复索取。
   */
  permanent: boolean
}

export type ImageFetchResult = { bytes: ImageBytes } | { failure: ImageFetchFailure }

/**
 * 能内联携带的最大图片体积。
 *
 * Base64 会胀三分之一，整个负载还要在 WebSocket 上抄一遍，所以更大的体积只是让三方
 * 白白占内存，换不来更好的答案：识别本来就会把图片缩到 800–1024px 左右。
 * 超过这个值，调用方就退回发 URL，让桌面端去取。
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 按文件扩展名推的媒体类型，给不返回 `Content-Type` 的服务器兜底。 */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/**
 * 二进制缓冲区的 Base64。
 *
 * 分块是因为 `String.fromCharCode(...bytes)` 会把每个字节摊进一次调用，
 * 一张几兆字节的图片能把参数列表撑爆——这种失败看起来像栈溢出，
 * 不像体积问题，所以从一开始就该绕开。
 *
 * @param buffer - 原始字节。
 * @returns 不带换行的标准 base64。
 */
export function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/**
 * 给响应挑一个最合适的媒体类型。
 *
 * @param header - `Content-Type` 头，有就传进来。
 * @param url - 字节来源的 URL，用来兜底。
 * @returns 一个媒体类型；一点线索都没有时返回 `application/octet-stream`。
 */
export function mediaTypeOf(header: string | null, url: string): string {
  const declared = header?.split(';')[0]?.trim() ?? ''
  if (declared !== '' && declared !== 'application/octet-stream') return declared
  const path = url.split('?')[0]?.split('#')[0] ?? ''
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  return MEDIA_TYPES[extension] ?? 'application/octet-stream'
}

/** 本地解码 `data:` URL 拿到的字节。 */
function dataUrlBytes(url: string): ImageFetchResult {
  const comma = url.indexOf(',')
  if (comma < 0) {
    return { failure: { code: 'unsupported-url', message: 'malformed data URL', permanent: true } }
  }
  const header = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  const declared = header.split(';')[0] ?? ''
  const mediaType = declared === '' ? 'text/plain' : declared
  if (!header.includes(';base64')) {
    // 图片里百分号编码的负载很少见，解它还得另写一套规则；
    // 宁可拒绝，也不去猜这些字节。
    return { failure: { code: 'unsupported-url', message: 'non-base64 data URL', permanent: true } }
  }
  if (payload.length === 0) {
    return { failure: { code: 'empty', message: 'data URL carried no bytes', permanent: false } }
  }
  // 4 个 base64 字符装 3 个字节；预算卡的是解码后的体积。
  if (Math.floor(payload.length * 3 / 4) > MAX_IMAGE_BYTES) {
    return { failure: { code: 'too-large', message: 'data URL is over the image budget', permanent: true } }
  }
  return { bytes: { mediaType, base64: payload } }
}

/** 给一张图片发什么，以及字节缺了的话缺在哪儿。 */
export interface ChosenImageSource {
  /** 描述图片用的源；没有东西可发时为 `undefined`。 */
  source: ImageSource | undefined
  /** 取字节被拒时，fetch 的失败代码。 */
  byteFailure: string | undefined
}

/**
 * 定下一张图片要发什么。
 *
 * 关键就在顺序上，而这个顺序一度是错的。
 * 先取字节、再查缓存，结果是已经描述过的图片每被问一次就真下载一次
 * ——manifest 把非 loopback 主机全拒了的时候看不出来，因为 fetch 瞬间就失败，
 * 一旦不再拒，那就是一次约 0.06–0.19s 的下载。
 * 所以调用方要说清答案是不是已经有了，
 * 只有字节确实用得上时才去取。
 *
 * @param url - 图片地址；页面没给地址时为 `''`。
 * @param alreadyAnswered - 这个身份已经描述过时为 true。
 * @param fetchBytes - 要用的 fetch，可注入以便测试。
 * @returns 要发的源，以及任何值得上报的字节失败。
 */
export async function chooseImageSource(
  url: string,
  alreadyAnswered: boolean,
  fetchBytes: (url: string) => Promise<ImageFetchResult> = fetchImageBytes,
): Promise<ChosenImageSource> {
  // 缓存命中只要一个 source 对象，不要它的内容：协调者还没看交给它的东西，
  // 就已经用缓存把答案给出了。
  if (alreadyAnswered) {
    return { source: url === '' ? undefined : { kind: 'url', url }, byteFailure: undefined }
  }
  if (url === '') return { source: undefined, byteFailure: undefined }
  const fetched = await fetchBytes(url)
  if ('bytes' in fetched) {
    return {
      source: { kind: 'bytes', mediaType: fetched.bytes.mediaType, base64: fetched.bytes.base64 },
      byteFailure: undefined,
    }
  }
  return { source: { kind: 'url', url }, byteFailure: fetched.failure.code }
}

/**
 * 取一张图片的字节。
 *
 * @param url - 绝对图片 URL（`http:`、`https:` 或 `data:`）。
 * @param fetchImpl - fetch 实现，可注入以便测试。
 * @returns 字节，或者一个分好类的失败。
 */
export async function fetchImageBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageFetchResult> {
  if (url === '') {
    return { failure: { code: 'unsupported-url', message: 'image has no address', permanent: true } }
  }
  if (url.startsWith('data:')) return dataUrlBytes(url)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    // `blob:` URL 只有创建它的上下文读得了，那是页面，不是这个 worker。
    // 把协议名报出来，失败才读得懂，而不至于看着像网络错误。
    const scheme = url.slice(0, url.indexOf(':') + 1)
    return {
      failure: { code: 'unsupported-url', message: `cannot read ${scheme} URLs from the worker`, permanent: true },
    }
  }

  let response: Response
  try {
    // 字节在这里取而不是在桌面端取，关键就在 `include`：
    // 请求会带上用户在他们登录过的主机上的 cookies。
    response = await fetchImpl(url, { credentials: 'include', redirect: 'follow' })
  } catch (error) {
    return {
      failure: { code: 'fetch-failed', message: error instanceof Error ? error.message : String(error), permanent: false },
    }
  }
  if (!response.ok) {
    return {
      failure: { code: 'fetch-failed', message: `HTTP ${String(response.status)}`, permanent: false },
    }
  }
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    return { failure: { code: 'too-large', message: `${String(declaredLength)} bytes declared`, permanent: true } }
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength === 0) {
    return { failure: { code: 'empty', message: 'response body was empty', permanent: false } }
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { failure: { code: 'too-large', message: `${String(buffer.byteLength)} bytes`, permanent: true } }
  }
  return {
    bytes: {
      mediaType: mediaTypeOf(response.headers.get('content-type'), url),
      base64: base64Of(buffer),
    },
  }
}
