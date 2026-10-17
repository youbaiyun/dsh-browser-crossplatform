// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  base64Of,
  chooseImageSource,
  fetchImageBytes,
  mediaTypeOf,
  type ImageFetchResult,
} from '../src/background/image-fetch.ts'

/** 最小的 `Response` 替身：只留 fetcher 会读的那部分。 */
function response(init: {
  ok?: boolean
  status?: number
  contentType?: string | null
  contentLength?: string | null
  body?: ArrayBuffer
}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: {
      get(name: string): string | null {
        const key = name.toLowerCase()
        if (key === 'content-type') return init.contentType ?? null
        if (key === 'content-length') return init.contentLength ?? null
        return null
      },
    },
    arrayBuffer: async (): Promise<ArrayBuffer> => init.body ?? new ArrayBuffer(0),
  } as unknown as Response
}

describe('base64Of', () => {
  it('encodes bytes', () => {
    expect(base64Of(new Uint8Array([1, 2, 3]).buffer)).toBe('AQID')
    expect(base64Of(new TextEncoder().encode('hi').buffer as ArrayBuffer)).toBe('aGk=')
  })

  it('encodes a body larger than the argument-list limit', () => {
    // 分块的意义就在这里：一次展开 10 万个参数的调用会抛错，
    // 而抛出的错误读起来像栈溢出，不像尺寸问题。
    const big = new Uint8Array(100_000).fill(65)
    const encoded = base64Of(big.buffer)
    expect(encoded.length).toBe(Math.ceil(100_000 / 3) * 4)
    expect(encoded.startsWith('QUFB')).toBe(true)
  })
})

describe('mediaTypeOf', () => {
  it('prefers the declared content type without its parameters', () => {
    expect(mediaTypeOf('image/jpeg; charset=binary', 'https://x.test/a')).toBe('image/jpeg')
  })

  it('falls back to the file extension', () => {
    expect(mediaTypeOf(null, 'https://x.test/photo.webp?v=2')).toBe('image/webp')
    expect(mediaTypeOf('application/octet-stream', '/assets/chart.SVG')).toBe('image/svg+xml')
  })

  it('reports an unknown type as octet-stream rather than guessing', () => {
    expect(mediaTypeOf(null, 'https://x.test/image?id=7')).toBe('application/octet-stream')
  })
})

describe('fetchImageBytes', () => {
  it('reads a data URL locally without any request', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchImageBytes('data:image/gif;base64,R0lGOD', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ bytes: { mediaType: 'image/gif', base64: 'R0lGOD' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a non-base64 data URL as permanently unreadable', async () => {
    const result = await fetchImageBytes('data:image/svg+xml,%3Csvg%3E')
    expect(result).toEqual({
      failure: { code: 'unsupported-url', message: 'non-base64 data URL', permanent: true },
    })
  })

  it('refuses a blob URL the worker cannot read', async () => {
    const result = await fetchImageBytes('blob:https://x.test/9a7b')
    expect(result).toMatchObject({ failure: { code: 'unsupported-url', permanent: true } })
  })

  it('fetches a real image host, which the manifest now allows', async () => {
    // worker 带着用户的 cookie，桌面中继做不到，所以
    // 需要登录的图片只能从这里读。`connect-src` 允许 `https:`
    // 就是为这件事，别无其他。
    const fetchImpl = vi.fn(async () => response({ contentType: 'image/png', body: new Uint8Array([1, 2, 3]).buffer }))
    const result = await fetchImageBytes('https://vcg05.cfp.cn/creative/a.jpg', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ bytes: { mediaType: 'image/png', base64: 'AQID' } })
  })

  it('fetches with credentials so the user stays signed in', async () => {
    const fetchImpl = vi.fn(async () => response({ contentType: 'image/png', body: new Uint8Array([1, 2, 3]).buffer }))
    const result = await fetchImageBytes('https://x.test/a.png', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ bytes: { mediaType: 'image/png', base64: 'AQID' } })
    expect(fetchImpl).toHaveBeenCalledWith('https://x.test/a.png', { credentials: 'include', redirect: 'follow' })
  })

  it('classifies a non-2xx response as a retryable failure', async () => {
    const fetchImpl = vi.fn(async () => response({ ok: false, status: 403 }))
    const result = await fetchImageBytes('https://x.test/a.png', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ failure: { code: 'fetch-failed', message: 'HTTP 403', permanent: false } })
  })

  it('classifies a thrown request as a retryable failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('Failed to fetch') })
    const result = await fetchImageBytes('https://x.test/a.png', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ failure: { code: 'fetch-failed', message: 'Failed to fetch', permanent: false } })
  })

  it('refuses a declared body over the budget without reading it', async () => {
    const body = vi.fn(async () => new ArrayBuffer(0))
    const fetchImpl = vi.fn(async () => ({
      ...response({ contentLength: String(MAX_IMAGE_BYTES + 1) }),
      arrayBuffer: body,
    }) as unknown as Response)
    const result = await fetchImageBytes('https://x.test/huge.png', fetchImpl as unknown as typeof fetch)
    expect(result).toMatchObject({ failure: { code: 'too-large', permanent: true } })
    // 只看响应头就够了：为了发现它太大去读 4MB，浪费的正是
    // 预算本来要保护的带宽。
    expect(body).not.toHaveBeenCalled()
  })

  it('refuses a body that arrives over the budget', async () => {
    const oversized = new ArrayBuffer(MAX_IMAGE_BYTES + 1)
    const fetchImpl = vi.fn(async () => response({ body: oversized }))
    const result = await fetchImageBytes('https://x.test/huge.png', fetchImpl as unknown as typeof fetch)
    expect(result).toMatchObject({ failure: { code: 'too-large', permanent: true } })
  })

  it('reports an empty body as retryable', async () => {
    const fetchImpl = vi.fn(async () => response({ body: new ArrayBuffer(0) }))
    const result = await fetchImageBytes('https://x.test/empty.png', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ failure: { code: 'empty', message: 'response body was empty', permanent: false } })
  })

  it('reports an addressless image without a request', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchImageBytes('', fetchImpl as unknown as typeof fetch)
    expect(result).toMatchObject({ failure: { code: 'unsupported-url', permanent: true } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('chooseImageSource', () => {
  const refused = async (): Promise<ImageFetchResult> => ({
    failure: { code: 'fetch-failed', message: 'HTTP 403', permanent: false },
  })

  it('does not download an image whose description is already known', async () => {
    // 这里钉住的那个回归。在查缓存之前就去抓，曾让每个重复提问
    // 都付出一次真实下载的代价——那是在 manifest 不再拦真实主机之后；
    // 它返回的来源从没被读过，因为协调器在看拿到的东西之前
    // 就已经从缓存给出答案了。
    const fetchImpl = vi.fn()
    const chosen = await chooseImageSource('https://vcg05.cfp.cn/creative/a.jpg', true, fetchImpl)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(chosen.source).toEqual({ kind: 'url', url: 'https://vcg05.cfp.cn/creative/a.jpg' })
    expect(chosen.byteFailure).toBeUndefined()
  })

  it('prefers bytes when the answer is not known yet', async () => {
    const chosen = await chooseImageSource('https://x.test/a.png', false, async () => ({
      bytes: { mediaType: 'image/png', base64: 'AQID' },
    }))
    expect(chosen).toEqual({
      source: { kind: 'bytes', mediaType: 'image/png', base64: 'AQID' },
      byteFailure: undefined,
    })
  })

  it('falls back to the URL and reports the code when the fetch fails', async () => {
    const chosen = await chooseImageSource('https://x.test/a.png', false, refused)
    expect(chosen.source).toEqual({ kind: 'url', url: 'https://x.test/a.png' })
    expect(chosen.byteFailure).toBe('fetch-failed')
  })

  it('sends nothing when the page gave no address, answered or not', async () => {
    const fetchImpl = vi.fn()
    expect(await chooseImageSource('', false, fetchImpl)).toEqual({ source: undefined, byteFailure: undefined })
    expect(await chooseImageSource('', true, fetchImpl)).toEqual({ source: undefined, byteFailure: undefined })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
