import { describe, expect, it } from 'vitest'
import { ImageRelay } from '../src/image-relay.ts'
import type { VisionClient, VisionRequest } from '../src/vision.ts'
import type { ImageRecognitionRequest } from '@dsh-browser/protocol'

const REQUEST: ImageRecognitionRequest = {
  identity: 'https://cdn.test/a.png',
  alt: '',
  near: '精灵手办',
  heading: '商品详情',
  kind: 'content',
}

/** 一个会记录自己被问了什么、并给出固定一行的 vision 客户端。 */
function stubVision(answer: { ok: true; desc: string } | { ok: false; code: string; message: string }): {
  seen: VisionRequest[]
  client: VisionClient
} {
  const seen: VisionRequest[] = []
  return {
    seen,
    client: {
      describe: async (request: VisionRequest) => {
        seen.push(request)
        return answer
      },
    } as unknown as VisionClient,
  }
}

function imageResponse(body: BlobPart, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

describe('image relay', () => {
  it('is unavailable when no vision model is configured', async () => {
    const relay = new ImageRelay(undefined)

    expect(relay.available).toBe(false)
    const result = await relay.recognize(REQUEST, { kind: 'bytes', mediaType: 'image/webp', base64: 'AAAA' })
    expect(result).toEqual({ ok: false, code: 'no-vision', message: expect.any(String) })
  })

  it('advertises itself once a vision model exists', () => {
    expect(new ImageRelay(stubVision({ ok: true, desc: 'x' }).client).available).toBe(true)
  })

  it('passes extension bytes straight through with the page context', async () => {
    const { seen, client } = stubVision({ ok: true, desc: '白色头发的精灵' })
    const relay = new ImageRelay(client)

    const result = await relay.recognize(REQUEST, { kind: 'bytes', mediaType: 'image/webp', base64: 'AAAA' })

    expect(result).toEqual({ ok: true, desc: '白色头发的精灵' })
    expect(seen[0]?.base64).toBe('AAAA')
    expect(seen[0]?.context).toEqual({ alt: '', near: '精灵手办', heading: '商品详情', kind: 'content' })
  })

  it('fetches by url when the extension could not', async () => {
    const { seen, client } = stubVision({ ok: true, desc: '桌面取到了' })
    const relay = new ImageRelay(client, (async () => imageResponse(new Uint8Array([1, 2, 3]), 'image/png')) as unknown as typeof fetch)

    const result = await relay.recognize(REQUEST, { kind: 'url', url: 'https://cdn.test/a.png' })

    expect(result).toEqual({ ok: true, desc: '桌面取到了' })
    expect(seen[0]?.mediaType).toBe('image/png')
    expect(seen[0]?.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('classifies a refused url fetch', async () => {
    const relay = new ImageRelay(stubVision({ ok: true, desc: 'x' }).client, (async () => imageResponse('no', 'text/html', 403)) as unknown as typeof fetch)

    const result = await relay.recognize(REQUEST, { kind: 'url', url: 'https://cdn.test/a.png' })

    expect(result).toEqual({ ok: false, code: 'relay-http', message: '403' })
  })

  it('refuses a url that did not return an image', async () => {
    const relay = new ImageRelay(stubVision({ ok: true, desc: 'x' }).client, (async () => imageResponse('<html>', 'text/html')) as unknown as typeof fetch)

    const result = await relay.recognize(REQUEST, { kind: 'url', url: 'https://cdn.test/login' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('not-an-image')
  })

  it('reports a network failure instead of throwing', async () => {
    const relay = new ImageRelay(stubVision({ ok: true, desc: 'x' }).client, (async () => { throw new Error('offline') }) as unknown as typeof fetch)

    const result = await relay.recognize(REQUEST, { kind: 'url', url: 'https://cdn.test/a.png' })

    expect(result.ok === false && result.code).toBe('relay-network')
  })

  it('refuses a scheme it cannot fetch', async () => {
    const relay = new ImageRelay(stubVision({ ok: true, desc: 'x' }).client)

    const result = await relay.recognize(REQUEST, { kind: 'url', url: 'blob:https://example.test/abc' })

    expect(result.ok === false && result.code).toBe('bad-url')
  })

  it('refuses oversized relayed bytes before sending them to a model', async () => {
    const relay = new ImageRelay(stubVision({ ok: true, desc: 'x' }).client)

    const result = await relay.recognize(REQUEST, { kind: 'bytes', mediaType: 'image/png', base64: 'A'.repeat(12_000_001) })

    expect(result.ok === false && result.code).toBe('too-large')
  })

  it('carries a model failure back as its own code', async () => {
    const { client } = stubVision({ ok: false, code: 'vision-http', message: '429' })
    const relay = new ImageRelay(client)

    const result = await relay.recognize(REQUEST, { kind: 'bytes', mediaType: 'image/webp', base64: 'AAAA' })

    expect(result).toEqual({ ok: false, code: 'vision-http', message: '429' })
  })
})
