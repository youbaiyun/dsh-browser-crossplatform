import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
  VISION_DECLINE,
  VISION_RELATION_PROMPT,
  VISION_SYSTEM_PROMPT,
  buildVisionRequestBody,
  isClientFrame,
  isPolicy,
  isServerFrame,
  parseBridgeFrame,
} from '../src/index.ts'

const caps = { textOnly: true as const, snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS, maxInteractiveItems: 60 }

test('hello.ok requires caps and policy', () => {  const ok = parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps, policy: { openPagesForUser: false } }))
  assert.ok(ok && ok.t === 'hello.ok')
  assert.equal(ok.policy.openPagesForUser, false)

  // 传输途中丢掉的 policy 字段必须被拒绝，而不是套用默认值。
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps })), undefined)
})

test('tool.call validates args, expiry, and sessionId', () => {
  const ok = parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: { index: 3 }, expiresAt: 999 }))
  assert.ok(ok && ok.t === 'tool.call')
  assert.equal(ok.sessionId, undefined)

  const withSession = parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: {}, expiresAt: 999, sessionId: 's1' }))
  assert.ok(withSession && withSession.t === 'tool.call' && withSession.sessionId === 's1')

  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: {}, expiresAt: 999, sessionId: '  ' })), undefined)
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: [1], expiresAt: 999 })), undefined)
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: {}, expiresAt: 0 })), undefined)
})

test('caps reject undersized snapshot budget', () => {
  const bad = { textOnly: true, snapshotMaxChars: MIN_SNAPSHOT_MAX_CHARS - 1, maxInteractiveItems: 60 }
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps: bad })), undefined)
})

test('tool.result and respond.result share one error validator', () => {
  const toolErr = parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '1', ok: false, error: { code: 'timeout', message: 'x' } }))
  assert.ok(toolErr && toolErr.t === 'tool.result' && toolErr.ok === false && toolErr.error.code === 'timeout')

  const respondErr = parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: '1', ok: false, error: { code: 'internal', message: 'x' } }))
  assert.ok(respondErr && respondErr.t === 'respond.result' && respondErr.ok === false)
})

test('malformed input is rejected, not thrown', () => {
  assert.equal(parseBridgeFrame(''), undefined)
  assert.equal(parseBridgeFrame('not json'), undefined)
  assert.equal(parseBridgeFrame('null'), undefined)
  assert.equal(parseBridgeFrame('[1,2]'), undefined)
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'nope' })), undefined)
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x' })), undefined) // 缺 caps
})

test('guards separate client and server vocabulary', () => {
  const hello = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'x', caps }))!
  const ping = parseBridgeFrame(JSON.stringify({ t: 'ping' }))!
  assert.ok(isClientFrame(hello) && !isServerFrame(hello))
  assert.ok(isServerFrame(ping) && !isClientFrame(ping))
})

test('isPolicy accepts only a boolean field', () => {
  assert.equal(isPolicy({ openPagesForUser: true }), true)
  assert.equal(isPolicy({ openPagesForUser: 'yes' }), false)
  assert.equal(isPolicy({}), false)
  assert.equal(isPolicy(null), false)
})

test('imageRecognition is optional but must be a boolean when present', () => {
  // 缺失表示“这里没有看图模型”，这是一种受支持的状态，而不是一个被丢掉的
  // 字段——不像 openPagesForUser，那里缺失是会被拒绝的。
  assert.equal(isPolicy({ openPagesForUser: true }), true)
  assert.equal(isPolicy({ openPagesForUser: true, imageRecognition: true }), true)
  assert.equal(isPolicy({ openPagesForUser: true, imageRecognition: false }), true)
  assert.equal(isPolicy({ openPagesForUser: true, imageRecognition: 'yes' }), false)
})

const imageRequest = { identity: 'https://cdn.test/a.png', alt: '', near: '精灵手办', heading: '商品详情', kind: 'content' }

test('image.call accepts bytes or a url, and rejects anything else', () => {
  const bytes = parseBridgeFrame(JSON.stringify({
    t: 'image.call',
    id: '1',
    request: imageRequest,
    source: { kind: 'bytes', mediaType: 'image/webp', base64: 'AAAA' },
  }))
  assert.ok(bytes && bytes.t === 'image.call')
  assert.equal(isClientFrame(bytes) && !isServerFrame(bytes), true)

  const url = parseBridgeFrame(JSON.stringify({
    t: 'image.call',
    id: '2',
    request: imageRequest,
    source: { kind: 'url', url: 'https://cdn.test/a.png' },
  }))
  assert.ok(url && url.t === 'image.call')

  // 空 url 不是一种 source，未知的 kind 更是完全不算 source。
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'image.call', id: '3', request: imageRequest, source: { kind: 'url', url: '' } })), undefined)
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'image.call', id: '4', request: imageRequest, source: { kind: 'inline' } })), undefined)
  // 上下文字段是必需的：没有它们的答案不可能是关于这张图的。
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'image.call', id: '5', request: { identity: 'x' }, source: { kind: 'bytes', mediaType: 'image/png', base64: 'A' } })), undefined)
})

test('image.result carries either a description or a classified error', () => {
  const ok = parseBridgeFrame(JSON.stringify({ t: 'image.result', id: '1', ok: true, desc: '白色头发的精灵' }))
  assert.ok(ok && ok.t === 'image.result' && ok.ok)
  assert.equal(ok.desc, '白色头发的精灵')
  assert.equal(isServerFrame(ok) && !isClientFrame(ok), true)

  const failed = parseBridgeFrame(JSON.stringify({ t: 'image.result', id: '1', ok: false, error: { code: 'vision-http', message: '429' } }))
  assert.ok(failed && failed.t === 'image.result' && !failed.ok)
  assert.equal(failed.error.code, 'vision-http')

  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'image.result', id: '1', ok: true })), undefined)
  assert.equal(parseBridgeFrame(JSON.stringify({ t: 'image.result', id: '1', ok: false })), undefined)
})

test('the tier decides which question the vision model is asked', () => {
  const image = { base64: 'AQID', mediaType: 'image/png' }
  const base = { alt: '季度营收', near: '', heading: '', kind: 'content' }
  const body = (tier?: string): Record<string, unknown> => buildVisionRequestBody(
    { model: 'm', extraBody: {} },
    image,
    tier === undefined ? base : { ...base, tier },
  )
  const systemOf = (value: Record<string, unknown>): string => {
    const messages = value.messages as { role: string; content: unknown }[]
    return String(messages.find((message) => message.role === 'system')?.content)
  }

  assert.equal(systemOf(body('standard')), VISION_SYSTEM_PROMPT)
  // 一个早于 tier 的发送方仍然问那个基础问题，而不是被拒绝，这就是这个字段在
  // 线上协议里可选的原因。
  assert.equal(systemOf(body()), VISION_SYSTEM_PROMPT)
  assert.equal(systemOf(body('enhanced')), VISION_RELATION_PROMPT)
  assert.ok(systemOf(body('enhanced')).includes('doing on this page'))
  // 两套提示词都保留了那个每个解析器都当作“拒绝”的 token。
  assert.ok(systemOf(body('enhanced')).includes(VISION_DECLINE))
  assert.ok(systemOf(body('standard')).includes(VISION_DECLINE))
})
