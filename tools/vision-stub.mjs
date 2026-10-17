/**
 * 一个替身视觉端点，用来在没有提供方的情况下测量整个往返。
 *
 * 它会以真实端点会接受的同一种请求形状作答，延迟由你指定。
 * 因为延迟是唯一慢的部分，你在延迟之外观察到的一切就是扩展、桥接和填充的耗时
 * ——而这正是值得在花钱找人测出来之前先搞清楚的部分。
 *
 * 它也是端到端检查直连路径最便宜的方式：扩展的策略本来就允许回环地址，
 * 所以把面板指向它不需要改 manifest，也不需要 key。
 *
 * 请求体从不打印：里面是用户的图片。只打印它的大小。
 *
 * 用法：
 *   node tools/vision-stub.mjs                 # 800ms 后作答
 *   STUB_MS=2500 node tools/vision-stub.mjs    # 或者任何你想感受的数值
 *   STUB_DESC=一张季度营收折线图 node tools/vision-stub.mjs
 *
 * 然后把面板的云端地址设为 http://127.0.0.1:9099/v1，key 留空。
 * 请求一张图片，控制台就会打印它收到了什么、以及是什么时候收到的。
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? '9099')
const HOST = '127.0.0.1'
const DELAY_MS = Number(process.env.STUB_MS ?? '800')
const DESCRIPTION = process.env.STUB_DESC ?? '一张折线图，横轴是季度，纵轴是营收'

const server = createServer((request, response) => {
  const path = request.url ?? '/'
  if (request.method === 'GET' && path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ delayMs: DELAY_MS, description: DESCRIPTION }))
    return
  }
  if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'this stub answers POST …/chat/completions only' } }))
    return
  }
  void (async () => {
    const receivedAt = performance.now()
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    // 请求里有多少是图片本身，而不是包着它的外壳。
    // base64 只测量、从不打印：那是用户的图片。
    const imageChars = /"url":\s*"data:[^;]+;base64,([A-Za-z0-9+/=]*)"/.exec(body.toString('utf8'))?.[1].length ?? 0
    console.log(
      `[vision-stub] request in  ${(body.length / 1024).toFixed(1)}KB`
      + `  (image ${(imageChars * 3 / 4 / 1024).toFixed(1)}KB)`
      + `  waiting ${String(DELAY_MS)}ms`,
    )
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { content: DESCRIPTION } }],
        usage: { prompt_tokens: 0, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 } },
      }))
      console.log(`[vision-stub] answered after ${String(Math.round(performance.now() - receivedAt))}ms`)
    }, DELAY_MS)
  })()
})

server.listen(PORT, HOST, () => {
  console.log(`[vision-stub] http://${HOST}:${String(PORT)}/v1  answering after ${String(DELAY_MS)}ms`)
  console.log(`[vision-stub] panel cloud address: http://${HOST}:${String(PORT)}/v1   key: leave empty`)
})
