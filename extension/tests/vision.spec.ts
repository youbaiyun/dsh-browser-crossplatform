// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ClientFrame, ImageRecognitionRequest, ImageSource, ServerFrame } from '@dsh-browser/protocol'
import { MAX_DESC_CHARS, THINKING_OFF, VISION_MARKER_CHARS } from '@dsh-browser/protocol'
import { ImageCache } from '../src/background/image-cache.ts'
import {
  BridgeRecognizer,
  DirectRecognizer,
  VisionCoordinator,
  chatCompletionsUrl,
  describeOutcomeText,
  isPermanentVisionCode,
  type RecognitionTarget,
} from '../src/background/vision.ts'

const REQUEST: ImageRecognitionRequest = {
  identity: 'https://x.test/chart.png',
  alt: '季度营收',
  near: '营收趋势',
  heading: '财务',
  kind: 'content',
}

const BYTES: ImageSource = { kind: 'bytes', mediaType: 'image/png', base64: 'AQID' }

const TARGET: RecognitionTarget = {
  identity: 'https://x.test/chart.png',
  alt: '季度营收',
  near: '营收趋势',
  heading: '财务',
  kind: 'content',
}

/** 抓住已发出的帧并交回它们的 id，这样测试就能应答它们。 */
function recorder(): { frames: ClientFrame[]; send: (frame: ClientFrame) => boolean } {
  const frames: ClientFrame[] = []
  return { frames, send: (frame) => { frames.push(frame); return true } }
}

/** 已录下的帧里第 n 个 image.call 的 id。 */
function callId(frames: ClientFrame[], index = 0): string {
  const calls = frames.filter((frame): frame is Extract<ClientFrame, { t: 'image.call' }> => frame.t === 'image.call')
  const call = calls[index]
  if (call === undefined) throw new Error(`no image.call at index ${String(index)}`)
  return call.id
}

/** 构造一个协调器，让它的中继把内容发到 `options.frames` 里。 */
function coordinator(options: {
  frames: ClientFrame[]
  relay?: boolean
  cache?: ImageCache
  limit?: number
  pageText?: string
  timeoutMs?: number
}): VisionCoordinator {
  return new VisionCoordinator({
    cache: options.cache ?? new ImageCache(),
    send: (frame) => { options.frames.push(frame); return true },
    canRelay: () => options.relay ?? true,
    pageText: () => options.pageText ?? '',
    timeoutMs: options.timeoutMs ?? 5_000,
  }, options.limit ?? 2)
}

/** 等到协调器至少把一个帧放上线。 */
async function dispatched(frames: ClientFrame[]): Promise<void> {
  await vi.waitFor(() => { expect(frames.length).toBeGreaterThanOrEqual(1) })
}

describe('isPermanentVisionCode', () => {
  it('separates "asking again is pointless" from "try later"', () => {
    expect(isPermanentVisionCode('vision-unclear')).toBe(true)
    expect(isPermanentVisionCode('vision-unavailable')).toBe(true)
    expect(isPermanentVisionCode('image-too-large')).toBe(true)
    expect(isPermanentVisionCode('vision-failed')).toBe(false)
    expect(isPermanentVisionCode('image-timeout')).toBe(false)
  })
})

describe('BridgeRecognizer', () => {
  it('sends the request and settles on the matching result frame', async () => {
    const { frames, send } = recorder()
    const recognizer = new BridgeRecognizer(send)
    const pending = recognizer.describe(REQUEST, BYTES, new AbortController().signal)

    const call = frames[0]
    expect(call).toMatchObject({ t: 'image.call', request: REQUEST, source: BYTES })
    expect(recognizer.pendingCount).toBe(1)

    expect(recognizer.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图' })).toBe(true)
    await expect(pending).resolves.toEqual({ ok: true, desc: '季度营收折线图' })
    expect(recognizer.pendingCount).toBe(0)
  })

  it('ignores frames that are not its own', () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send)
    expect(recognizer.handleFrame({ t: 'image.result', id: 'nobody', ok: true, desc: 'x' })).toBe(false)
    expect(recognizer.handleFrame({ t: 'ping' })).toBe(false)
  })

  it('reports a disconnected bridge without waiting', async () => {
    const recognizer = new BridgeRecognizer(() => false)
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'bridge-closed', message: 'no bridge connection', permanent: false })
  })

  it('classifies a declined image as permanent', async () => {
    const { frames, send } = recorder()
    const recognizer = new BridgeRecognizer(send)
    const pending = recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    recognizer.handleFrame({
      t: 'image.result',
      id: callId(frames),
      ok: false,
      error: { code: 'vision-unclear', message: 'the model declined' },
    })
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'vision-unclear', permanent: true })
  })

  it('gives up on a silent desktop', async () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send, 20)
    const outcome = await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(outcome).toMatchObject({ ok: false, code: 'image-timeout', permanent: false })
    expect(recognizer.pendingCount).toBe(0)
  })

  it('stops waiting when the caller cancels', async () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send, 5_000)
    const controller = new AbortController()
    const pending = recognizer.describe(REQUEST, BYTES, controller.signal)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'image-cancelled' })
    expect(recognizer.pendingCount).toBe(0)
  })

  it('settles every waiter when the socket drops', async () => {
    const { send } = recorder()
    const recognizer = new BridgeRecognizer(send, 5_000)
    const first = recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    const second = recognizer.describe({ ...REQUEST, identity: 'b' }, BYTES, new AbortController().signal)
    recognizer.failAll('bridge-closed', false)
    await expect(first).resolves.toMatchObject({ ok: false, code: 'bridge-closed' })
    await expect(second).resolves.toMatchObject({ ok: false, code: 'bridge-closed' })
    expect(recognizer.pendingCount).toBe(0)
  })
})

describe('DirectRecognizer', () => {
  function completion(content: string, usage?: Record<string, unknown>): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        ...usage === undefined ? {} : { usage },
      }),
    } as unknown as Response
  }

  it('refuses without a configured endpoint', async () => {
    const recognizer = new DirectRecognizer(() => undefined)
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, code: 'vision-unavailable', permanent: true })
  })

  it('refuses a URL source: this path sends bytes', async () => {
    const recognizer = new DirectRecognizer(() => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }))
    await expect(recognizer.describe(REQUEST, { kind: 'url', url: 'https://x.test/a.png' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, code: 'vision-needs-bytes' })
  })

  it('asks the shared question, with thinking off and no temperature', async () => {
    const fetchImpl = vi.fn(async () => completion('一张季度营收折线图'))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1', model: 'flash-vision', apiKey: 'secret' }),
      fetchImpl as unknown as typeof fetch,
    )
    const outcome = await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(outcome).toEqual({ ok: true, desc: '一张季度营收折线图', reasoningTokens: 0 })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    // 这些开关必须真的出现在请求体里：只有发出去过，
    // 才能发现一个把它们忽略掉的 provider。
    expect(body).toMatchObject({ model: 'flash-vision', temperature: 0, max_tokens: MAX_DESC_CHARS, ...THINKING_OFF })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
  })

  it('reports reasoning tokens when the provider billed thinking anyway', async () => {
    const fetchImpl = vi.fn(async () => completion('一张图', { completion_tokens_details: { reasoning_tokens: 348 } }))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, reasoningTokens: 348 })
  })

  it('treats an UNCLEAR answer as a permanent decline', async () => {
    const fetchImpl = vi.fn(async () => completion('UNCLEAR'))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, code: 'vision-unclear', permanent: true })
  })

  it('classifies a failed request as retryable', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 } as unknown as Response))
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1/chat', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await expect(recognizer.describe(REQUEST, BYTES, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'vision-failed', message: 'HTTP 429', permanent: false })
  })
})

describe('VisionCoordinator', () => {
  it('answers from the cache without a second request, and keeps its transport', async () => {
    const cache = new ImageCache()
    cache.set(TARGET.identity, '季度营收折线图', 'direct')
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, cache })
    const outcome = await vision.describe(TARGET, BYTES, new AbortController().signal)
    expect(frames).toEqual([])
    expect(outcome).toMatchObject({ ok: true, desc: '季度营收折线图', via: 'direct' })
  })

  it('describes through the relay and attaches the cross-modal verdict', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, pageText: '本季度营收 30%' })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal)
    await dispatched(frames)
    expect(vision.handleFrame({
      t: 'image.result',
      id: callId(frames),
      ok: true,
      desc: '季度营收折线图，达到 50%',
    })).toBe(true)
    const outcome = await pending
    expect(outcome).toMatchObject({ ok: true, via: 'desktop', thinkingIgnored: false })
    if (!outcome.ok) throw new Error('expected a description')
    // 页面说 30%，答案说 50%：本地检查必须抓住它。
    expect(outcome.comparison.verdict).toBe('conflict')
    expect(outcome.comparison.conflicts[0]?.rule).toBe('percentage')
  })

  it('sends one request for a page that repeats the same image', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const signal = new AbortController().signal
    const first = vision.describe(TARGET, BYTES, signal)
    const second = vision.describe(TARGET, BYTES, signal)
    await dispatched(frames)
    expect(frames).toHaveLength(1)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图' })
    await expect(first).resolves.toMatchObject({ ok: true, desc: '季度营收折线图' })
    await expect(second).resolves.toMatchObject({ ok: true, desc: '季度营收折线图' })
    expect(frames).toHaveLength(1)
  })

  it('runs no more recognitions at once than the limit allows', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, limit: 1 })
    const signal = new AbortController().signal
    const first = vision.describe(TARGET, BYTES, signal)
    const second = vision.describe({ ...TARGET, identity: 'b' }, BYTES, signal)
    await dispatched(frames)
    // 第二次会等槽位，不去抢桌面自己的上限。
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(frames).toHaveLength(1)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: 'A' })
    await first
    await vi.waitFor(() => { expect(frames).toHaveLength(2) })
    vision.handleFrame({ t: 'image.result', id: callId(frames, 1), ok: true, desc: 'B' })
    await second
  })

  it('stops asking for an image the model declined', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const signal = new AbortController().signal
    const first = vision.describe(TARGET, BYTES, signal)
    await dispatched(frames)
    vision.handleFrame({
      t: 'image.result',
      id: callId(frames),
      ok: false,
      error: { code: 'vision-unclear', message: 'declined' },
    })
    await expect(first).resolves.toMatchObject({ ok: false, code: 'vision-unclear' })

    const second = await vision.describe(TARGET, BYTES, signal)
    expect(second).toMatchObject({ ok: false, code: 'vision-skipped', permanent: true })
    expect(frames).toHaveLength(1)
  })

  it('skips the cross-check on the low tier, and says so', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, pageText: '本季度营收 30%' })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal, 'low')
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图，达到 50%' })
    const outcome = await pending
    if (!outcome.ok) throw new Error('expected a description')
    // 同一个答案在标准档位下算冲突；低档位拿不检查
    // 换便宜，所以必须把这点说出来，而不是报告一致。
    expect(outcome.comparison).toEqual({ verdict: 'uncertain', conflicts: [], basis: 'skipped', overlap: 0 })
    expect(describeOutcomeText(12, outcome)).toContain('skipped by the low tier')
  })

  it('runs the cross-check at the standard tier', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames, pageText: '本季度营收 30%' })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal, 'standard')
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '季度营收折线图，达到 50%' })
    const outcome = await pending
    if (!outcome.ok) throw new Error('expected a description')
    expect(outcome.comparison.verdict).toBe('conflict')
  })

  it('uses the direct path when the desktop cannot recognize images', async () => {
    // 只要中继能回答就优先用中继，所以这条路径是为
    // 它做不到的部署准备的——而且除非真把端点
    // 交给协调器，这条路径根本走不到，这正是这里要断言的。
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ choices: [{ message: { content: '一张折线图' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const vision = new VisionCoordinator({
      cache: new ImageCache(),
      send: () => { throw new Error('the relay must not be used when it is unavailable') },
      canRelay: () => false,
      directConfig: () => ({ endpoint: 'https://api.test/v1/chat/completions', model: 'm', apiKey: 'k' }),
      pageText: () => '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(vision.canRecognize()).toBe(true)
    const outcome = await vision.describe(TARGET, BYTES, new AbortController().signal, 'standard')
    expect(outcome).toMatchObject({ ok: true, desc: '一张折线图', via: 'direct' })
    expect(urls[0]).toContain('api.test')
  })

  it('posts to chat/completions, the way the desktop client does', async () => {
    // 两种传输读的是同一个设置；读法不同就意味着一个 URL
    // 在一条路径上能用、在另一条上 404。
    expect(chatCompletionsUrl('https://api.test/v1')).toBe('https://api.test/v1/chat/completions')
    expect(chatCompletionsUrl('https://api.test/v1/')).toBe('https://api.test/v1/chat/completions')
    // 粘了完整 URL 的用户不该因此受罚。
    expect(chatCompletionsUrl('https://api.test/v1/chat/completions')).toBe('https://api.test/v1/chat/completions')

    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ choices: [{ message: { content: '一张图' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.test/v1', model: 'm', apiKey: 'k' }),
      fetchImpl as unknown as typeof fetch,
    )
    await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(urls[0]).toBe('https://api.test/v1/chat/completions')
  })

  it('classifies a refused direct call as retryable, without blaming the policy', async () => {
    const recognizer = new DirectRecognizer(
      () => ({ endpoint: 'https://api.example.com/v1/chat/completions', model: 'm', apiKey: 'k' }),
      (async () => { throw new Error('Failed to fetch') }) as unknown as typeof fetch,
    )
    const outcome = await recognizer.describe(REQUEST, BYTES, new AbortController().signal)
    expect(outcome).toMatchObject({ ok: false, code: 'vision-failed', permanent: false })
    if (outcome.ok) throw new Error('expected a failure')
    // 既然 `connect-src` 已经允许 `https:` 和 `http:`，端点主机就不再需要
    // manifest 条目，所以这里失败是端点的问题，不是
    // 扩展的问题。CSP 提示却会去建议一条已经不存在的规则。
    expect(outcome.message).toBe('Failed to fetch')
  })

  it('reports whether any path can answer', () => {
    expect(coordinator({ frames: [], relay: false }).canRecognize()).toBe(false)
    expect(coordinator({ frames: [], relay: true }).canRecognize()).toBe(true)
  })

  it('renders a remembered description for the snapshot', async () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal)
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: '一台笔记本电脑' })
    await pending
    expect(vision.descriptionOf(TARGET.identity)).toBe('一台笔记本电脑')
    expect(vision.stats()).toMatchObject({ described: 1 })
  })
})

describe('marker summaries', () => {
  it('summarises a long description in a marker but answers with it whole', async () => {
    // 快照会把每个标记都重复一遍，所以页面文本带着一份摘要，而
    // 描述本身由发起请求的那次调用完整返回。
    const long = '细节'.repeat(200)
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const pending = vision.describe(TARGET, BYTES, new AbortController().signal)
    await dispatched(frames)
    vision.handleFrame({ t: 'image.result', id: callId(frames), ok: true, desc: long })
    const outcome = await pending
    expect(outcome.ok && outcome.desc).toBe(long)
    const marker = vision.stateFor(TARGET.identity) ?? ''
    expect(marker.length).toBeLessThanOrEqual(VISION_MARKER_CHARS + 1)
    expect(marker.endsWith('…')).toBe(true)
  })
})

describe('describeOutcomeText', () => {
  const consistent = { verdict: 'consistent' as const, conflicts: [], basis: 'text' as const, overlap: 0.8 }

  it('wraps the description in the untrusted boundary', () => {
    // 描述是模型对一张这里没人写过的图片的解读，所以它
    // 和页面文本走在同一条边界之内。
    const text = describeOutcomeText(12, { ok: true, desc: '一张折线图', comparison: consistent, via: 'desktop', reasoningTokens: 0, thinkingIgnored: false })
    expect(text).toContain('<UNTRUSTED_PAGE_CONTENT')
    expect(text).toContain('一张折线图')
    expect(text).toContain('via desktop')
  })

  it('forbids acting on a conflicted description', () => {
    const text = describeOutcomeText(12, {
      ok: true,
      desc: '季度营收 50%',
      comparison: { verdict: 'conflict', conflicts: [{ rule: 'percentage', detail: 'description says 50% but the page states 30%' }], basis: 'text', overlap: 0.6 },
      via: 'desktop',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(text).toContain('CONFLICT')
    expect(text).toContain('description says 50% but the page states 30%')
    expect(text).toContain('Do not act')
  })

  it('says when nothing could be checked at all', () => {
    // 在这里报告「consistent」，就等于宣称做了一次根本没跑过的核验。
    const unchecked = describeOutcomeText(3, {
      ok: true,
      desc: '一台笔记本电脑',
      comparison: { verdict: 'uncertain', conflicts: [], basis: 'none', overlap: 0 },
      via: 'direct',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(unchecked).toContain('not possible, the page says nothing')
    const partial = describeOutcomeText(3, {
      ok: true,
      desc: '一台笔记本电脑',
      comparison: { verdict: 'uncertain', conflicts: [], basis: 'text', overlap: 0.25 },
      via: 'direct',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(partial).toContain('nothing conclusive')

    // 备注只当成观察上报，绝不作为要遵从的裁定。
    const noted = describeOutcomeText(3, {
      ok: true,
      desc: '一台笔记本电脑',
      comparison: {
        verdict: 'uncertain',
        conflicts: [],
        basis: 'text',
        overlap: 0.1,
        note: 'the description does not mention what the page says about this image (营收)',
      },
      via: 'desktop',
      reasoningTokens: 0,
      thinkingIgnored: false,
    })
    expect(noted).toContain('nothing conclusive — the description does not mention')
    expect(noted).not.toContain('CONFLICT')
    expect(noted).not.toContain('Do not act')
  })

  it('distinguishes a failure worth retrying from one that is not', () => {
    const permanent = describeOutcomeText(5, { ok: false, code: 'vision-unclear', message: 'declined', permanent: true })
    expect(permanent).toContain('will not be asked about again')
    const transient = describeOutcomeText(5, { ok: false, code: 'image-timeout', message: 'no answer', permanent: false })
    expect(transient).toContain('Trying again later may succeed')
  })

  it('surfaces a provider that billed thinking anyway, and a byte fallback', () => {
    const text = describeOutcomeText(7, {
      ok: true,
      desc: '一张图',
      comparison: consistent,
      via: 'direct',
      reasoningTokens: 348,
      thinkingIgnored: true,
    }, 'too-large')
    expect(text).toContain('348 reasoning tokens')
    expect(text).toContain('too-large')
  })
})

describe('ServerFrame routing', () => {
  it('leaves unrelated frames for the assembly', () => {
    const frames: ClientFrame[] = []
    const vision = coordinator({ frames })
    const toolCall: ServerFrame = { t: 'tool.call', id: 'x', name: 'browser_snapshot', args: {}, expiresAt: 0 }
    expect(vision.handleFrame(toolCall)).toBe(false)
  })
})
