#!/usr/bin/env node
// 对一个正在运行的 DSH 主机做桥接压测（只读 RPC，不触发任何写操作）。
//
// 用法：node packages/bridge/scripts/stress-bridge.mjs
// 环境变量：BRIDGE_URL（默认 ws://127.0.0.1:3080/ext/bridge）、BRIDGE_ORIGIN、
// BRIDGE_TOKEN_FILE、STRESS_BURST / STRESS_ROUNDS、STRESS_SKIP_HISTORY=1（跳过并发历史阶段）、
// STRESS_WITH_TOKEN=1（发送 token，而不是走商店扩展的免 token 路径）。
//
// 默认用 Web Store 打包扩展的 id 且**不带 token**，验证「商店版扩展免 token 直连」这条路。
// 注意：桥接只有一个活动连接，新连接会以 4000 踢掉旧连接；扩展面板会自动重连。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const BRIDGE_URL = process.env.BRIDGE_URL ?? 'ws://127.0.0.1:3080/ext/bridge'
const ORIGIN = process.env.BRIDGE_ORIGIN ?? 'chrome-extension://agpipnjijkpomaannkijkilggoffdiaf'
const TOKEN_FILE = process.env.BRIDGE_TOKEN_FILE ?? path.join(os.homedir(), '.dsh', 'ext-bridge-token')
const CAPS = { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 }
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 20)
const BURST = Number(process.env.STRESS_BURST ?? 50)
const RPC_TIMEOUT_MS = 15_000
const TOKEN = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : ''
// 商店版扩展拿不到开发机上的 token；默认不带，显式设置 STRESS_WITH_TOKEN=1 才带。
const USE_TOKEN = process.env.STRESS_WITH_TOKEN === '1'
const SKIP_HISTORY = process.env.STRESS_SKIP_HISTORY === '1'

let seq = 0
const samples = []
const problems = []
const frameTypes = new Map()

function record(phase, ms, error) {
  samples.push({ phase, ms, error })
}
function note(phase, message) {
  problems.push(`${phase}: ${message}`)
}

function percentile(sorted, q) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return sorted[index]
}

class Client {
  #ws
  #pending = new Map()
  #helloResolve
  #helloReject
  closed = false
  closeCode = 0
  frames = 0
  maxFrame = 0

  constructor() {
    this.#ws = new WebSocket(BRIDGE_URL, {
      headers: { Origin: ORIGIN },
      handshakeTimeout: 10_000,
    })
    this.#ws.on('message', (data) => this.#onMessage(data))
    this.#ws.on('close', (code) => {
      this.closed = true
      this.closeCode = code
      for (const { reject } of this.#pending.values()) reject(new Error(`closed:${code}`))
      this.#pending.clear()
      this.#helloReject?.(new Error(`closed:${code}`))
      this.#helloReject = undefined
    })
    this.#ws.on('error', (error) => note('socket', error.message))
  }

  #onMessage(data) {
    this.maxFrame = Math.max(this.maxFrame, data.length)
    let frame
    try {
      frame = JSON.parse(data.toString())
    } catch {
      note('frame', 'unparseable frame')
      return
    }
    this.frames += 1
    frameTypes.set(frame.t, (frameTypes.get(frame.t) ?? 0) + 1)
    if (frame.t === 'hello.ok') {
      this.#helloResolve?.(frame)
      this.#helloResolve = undefined
      return
    }
    if (frame.t === 'rpc.result') {
      const entry = this.#pending.get(frame.id)
      if (!entry) return
      this.#pending.delete(frame.id)
      entry.resolve(frame)
    }
  }

  async hello() {
    await new Promise((resolve, reject) => {
      this.#helloResolve = resolve
      this.#helloReject = reject
      this.#ws.once('open', () => {
        const hello = { t: 'hello', token: USE_TOKEN ? TOKEN : '', caps: CAPS }
        this.#ws.send(JSON.stringify(hello))
      })
      this.#ws.once('error', reject)
    })
  }

  rpc(method, payload = {}) {
    const id = `stress-${++seq}`
    const started = Date.now()
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`timeout:${method}`))
      }, RPC_TIMEOUT_MS)
      this.#pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.#ws.send(JSON.stringify({ t: 'rpc', id, method, payload }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
    return promise
      .then((frame) => {
        const ok = frame.ok === true && frame.result?.result?.ok !== false
        const message = frame.result?.result?.error?.message
        record(method, Date.now() - started, ok ? undefined : message ?? 'not-ok')
        return { frame, ok }
      })
      .catch((error) => {
        record(method, Date.now() - started, error.message)
        return { frame: undefined, ok: false }
      })
  }

  close() {
    this.closed = true
    this.#ws.close()
  }
}

async function connectAndHello() {
  const client = new Client()
  await client.hello()
  return client
}

function reportPhase(phase, client) {
  const rows = samples.filter((row) => row.phase === phase)
  if (rows.length === 0) return
  const latencies = rows.map((row) => row.ms).sort((a, b) => a - b)
  const errors = rows.filter((row) => row.error)
  const byMessage = new Map()
  for (const row of errors) byMessage.set(row.error, (byMessage.get(row.error) ?? 0) + 1)
  console.log(
    `  ${phase.padEnd(16)} n=${String(rows.length).padStart(4)} ok=${String(rows.length - errors.length).padStart(4)} ` +
      `p50=${percentile(latencies, 0.5)}ms p95=${percentile(latencies, 0.95)}ms ` +
      `p99=${percentile(latencies, 0.99)}ms max=${latencies.at(-1)}ms`,
  )
  for (const [message, count] of byMessage) console.log(`      ×${count} ${message}`)
  if (client?.closeCode === 4000) note(phase, 'connection was replaced mid-phase')
}

async function main() {
  console.log(`bridge   ${BRIDGE_URL}`)
  console.log(`origin   ${ORIGIN} (token ${USE_TOKEN ? 'sent' : 'omitted'})`)

  const main0 = Date.now()
  const client = await connectAndHello()
  console.log(`handshake  ${Date.now() - main0}ms`)

  // 先拿一个真实 Session id：带 sessionId 的 session.models 会多打一次 projections。
  const list = await client.rpc('session.list', {})
  record('session.list', 0, list.ok ? undefined : 'not-ok')
  const sessions = list.frame?.result?.result?.value?.items ?? []
  const sessionId = sessions.find((session) => session.sessionId)?.sessionId
  console.log(`sessions   n=${sessions.length} sessionId=${sessionId ?? 'none'}`)

  // 阶段一：并发 session.models（模型目录，无状态，可安全放大）。
  const modelsStart = Date.now()
  for (let round = 0; round < ROUNDS; round += 1) {
    const calls = []
    for (let index = 0; index < BURST; index += 1) {
      const payload = sessionId && index % 2 === 0 ? { sessionId } : {}
      calls.push(client.rpc('session.models', payload))
    }
    await Promise.all(calls)
  }
  reportPhase('session.models', client)
  console.log(`  burst: ${ROUNDS} rounds × ${BURST} in ${Date.now() - modelsStart}ms`)

  // 阶段二：历史页（走 session/follow 流 + 大记录集，是真正会搬运大量字节的路径）。
  if (sessionId && !SKIP_HISTORY) {
    await Promise.all(Array.from({ length: 5 }, () => client.rpc('session.history', { sessionId })))
    reportPhase('session.history', client)
    console.log(`  max frame ${(client.maxFrame / 1024).toFixed(0)} KiB`)
  }

  // 阶段二：工作区列表（每个调用都会开一条 workspace/follow 流再关掉，压的是流通道）。
  await Promise.all(Array.from({ length: 20 }, () => client.rpc('workspace.list', {})))
  reportPhase('workspace.list', client)

  // 阶段三：Session 列表。
  await Promise.all(Array.from({ length: 10 }, () => client.rpc('session.list', {})))
  reportPhase('session.list', client)

  client.close()

  // 阶段四：重连循环，测 hello 握手与替换旧连接（4000）的稳定性。
  for (let index = 0; index < 10; index += 1) {
    const started = Date.now()
    let reconnect
    try {
      reconnect = await connectAndHello()
    } catch (error) {
      note('reconnect', error.message)
      continue
    }
    const listed = await reconnect.rpc('session.list', {})
    record('reconnect', Date.now() - started, listed.ok ? undefined : 'not-ok')
    reconnect.close()
  }
  reportPhase('reconnect')

  // 阶段五：同时建立 5 条连接，确认「后到者替换，先到者 4000」，而不是挂死或报 1011。
  const sockets = []
  for (let index = 0; index < 5; index += 1) {
    const socket = new Client()
    sockets.push(socket)
    await socket.hello()
    await socket.rpc('session.list', {})
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  const closed = sockets.filter((socket) => socket.closed)
  const replaced = closed.filter((socket) => socket.closeCode === 4000)
  console.log(`replacement  ${closed.length}/5 closed, ${replaced.length} with 4000`)
  if (replaced.length !== 4) note('replacement', `expected 4 × 4000, saw ${replaced.length}`)
  for (const socket of sockets) socket.close()

  const frames = [...frameTypes.entries()].sort((a, b) => b[1] - a[1])
  console.log(`frames  ${frames.map(([type, count]) => `${type}×${count}`).join(' ')}`)

  const failed = samples.filter((row) => row.error).length
  console.log(problems.length === 0 && failed === 0 ? 'RESULT  PASS' : `RESULT  FAIL (${problems.length} problems, ${failed} failed calls)`)
  for (const problem of problems) console.log(`  ! ${problem}`)
  process.exitCode = problems.length === 0 && failed === 0 ? 0 : 1
}

await main()
