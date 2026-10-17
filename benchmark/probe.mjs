import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDshBackend } from './lib/dsh-process.mjs'
import { startExtensionBrowser } from './lib/extension-browser.mjs'
import { startBenchmarkSite } from './site/server.mjs'

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(benchmarkRoot, '..')
const probeId = `probe-${new Date().toISOString().replace(/[:.]/gu, '-')}`
const runtimeRoot = join(benchmarkRoot, 'results', 'runtime', probeId)
const resources = []
let extensionBrowser

try {
  const site = await startBenchmarkSite({ port: 4173 })
  resources.push(site)
  const playwright = await startDshBackend({
    backend: 'playwright',
    port: 3090,
    repoRoot,
    benchmarkRoot,
    runtimeRoot,
    startUrl: `${site.origin}/health`,
  })
  resources.push(playwright)
  const extension = await startDshBackend({
    backend: 'extension',
    port: 3091,
    repoRoot,
    benchmarkRoot,
    runtimeRoot,
    startUrl: `${site.origin}/health`,
  })
  resources.push(extension)
  // 演练真实的、已认证的 unary 以及 V3 的 follow/history 协议，但不提交任何
  // prompt，也不调用任何模型。
  for (const backend of [playwright, extension]) {
    const created = await backend.client.rpc('session.create', { cwd: runtimeRoot })
    const catalog = await backend.client.rpc('session.modelCatalog')
    await backend.client.rpc('session.selectModel', { sessionId: created.sessionId, ...catalog.default })
    await backend.client.followSession(created.sessionId)
    await backend.client.rpc('session.history', { sessionId: created.sessionId })
  }
  extensionBrowser = await startExtensionBrowser({
    repoRoot,
    benchmarkRoot,
    bridgeUrl: 'ws://127.0.0.1:3091/ext/bridge',
    trustedOrigin: site.origin,
  })
  console.log(JSON.stringify({
    ok: true,
    site: site.origin,
    playwright: playwright.baseUrl,
    extension: extension.baseUrl,
    controlledTab: extensionBrowser.target.url(),
    executable: extensionBrowser.executablePath,
    sessionTransport: 'Typert authenticated unary + V3 follow/history',
  }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  await extensionBrowser?.close().catch(() => undefined)
  for (const resource of resources.reverse()) await resource.close().catch(() => undefined)
}
