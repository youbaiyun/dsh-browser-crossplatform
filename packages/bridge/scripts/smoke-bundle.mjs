import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-bundle-home-'))
process.env.DSH_HOME = home

const gateway = {
  wireStream: {
    open: async () => ({
      async *[Symbol.asyncIterator]() { yield { type: 'ready', clientId: 'test', host: { home: '/tmp' } } },
    }),
    failure: (error) => ({ code: 'internal', message: String(error), details: {} }),
  },
  invoke: async () => undefined,
}
const connection = {
  createSharedFetchHandler: () => ({ fetch: async () => new Response('not found', { status: 404 }) }),
}

let upgrades = 0
const registered = []
const ctx = {
  webServer: { port: 0, registerUpgrade: () => { upgrades += 1; return () => {} }, register: () => () => {} },
  tools: { register: (tool) => { registered.push(tool); return () => {} } },
  agents: { get: () => undefined },
  get: (key) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined,
  on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => fn(),
}

try {
  const plugin = await import('../lib/index.js')
  await plugin.apply(ctx, {
    token: 'fixed-token',
    toolTimeoutMs: 90_000,
    snapshotMaxChars: 32_000,
    maxInteractiveItems: 60,
    discoveryListener: false,
    sessionWorkspacePath: '',
  })
  if (upgrades !== 1) throw new Error(`upgrade route registered ${upgrades} times, expected 1`)
  console.log(`ok: bundled plugin applied, ${upgrades} upgrade route, ${registered.length} tools registered`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
