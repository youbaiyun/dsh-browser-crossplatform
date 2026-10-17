/**
 * 图像识别的回环透传代理，让扩展无需改动 manifest 就能调用云端端点。
 *
 * 扩展的页面只能访问 manifest 的 `content_security_policy.connect-src` 里列出的主机，
 * 而该策略允许回环地址——`ws://127.0.0.1:*` 和 `http://127.0.0.1:*`，且仅限明文 http。
 * 因此把扩展指向这个代理既不用改 manifest，又能把提供方的 key 挡在扩展存储之外，
 * 还让提供方的延迟变得可见——而一次识别调用真正取决于的正是这个数字。
 *
 * 它只转发一种形状 —— `POST …/chat/completions` —— 因为扩展只发这一种请求。
 * 其他请求一律拒绝，而不是靠猜。
 *
 * 日志除了大小、耗时和状态什么都不记：请求体里带着用户的图片，一个把它们打印出来的
 * 代理，就等于把这些图片留在终端回滚缓冲区和任何收集它的地方。
 *
 * 用法：
 *   VISION_UPSTREAM=https://api.example.com/v1 VISION_KEY=sk-... \
 *     node tools/vision-proxy.mjs
 *
 * 然后把面板的云端地址设为 http://127.0.0.1:8080/v1
 */

import { createServer } from 'node:http'

const UPSTREAM = (process.env.VISION_UPSTREAM ?? '').replace(/\/+$/, '')
const KEY = process.env.VISION_KEY ?? ''
const PORT = Number(process.env.VISION_PORT ?? '8080')
const HOST = '127.0.0.1'

if (UPSTREAM === '') {
  console.error('Set VISION_UPSTREAM to the provider base URL, for example https://api.example.com/v1')
  process.exit(2)
}

/** 读取请求体时强制加上限，这样一个跑偏的上传无法耗尽内存。 */
async function readBody(request, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error(`request body over ${String(limit)} bytes`)
    chunks.push(chunk)
  }
  return { buffer: Buffer.concat(chunks), size }
}

const server = createServer((request, response) => {
  const path = request.url ?? '/'
  if (request.method === 'GET' && path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ upstream: UPSTREAM, hasKey: KEY !== '' }))
    return
  }
  if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'this proxy forwards POST …/chat/completions only' } }))
    return
  }

  void (async () => {
    const startedAt = performance.now()
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
      return
    }
    const upstreamAt = performance.now()
    try {
      const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 代理自己有 key 时以它为准，这样扩展可以把 key 字段留空，
          // 把密钥挡在自己的存储之外。
          authorization: `Bearer ${KEY === '' ? (request.headers.authorization ?? '').replace(/^Bearer /, '') : KEY}`,
        },
        body: body.buffer,
      })
      const text = await upstream.text()
      const finishedAt = performance.now()
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      response.end(text)
      console.log(
        `[vision-proxy] ${upstream.status}  upstream ${Math.round(finishedAt - upstreamAt)}ms`
        + `  total ${Math.round(finishedAt - startedAt)}ms`
        + `  in ${(body.size / 1024).toFixed(0)}KB  out ${(text.length / 1024).toFixed(1)}KB`,
      )
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
      console.log(`[vision-proxy] upstream failed after ${Math.round(performance.now() - upstreamAt)}ms: ${String(error)}`)
    }
  })()
})

server.listen(PORT, HOST, () => {
  console.log(`[vision-proxy] ${HOST}:${String(PORT)} → ${UPSTREAM}/chat/completions`)
  console.log(`[vision-proxy] set the panel's cloud address to http://${HOST}:${String(PORT)}/v1`)
})
