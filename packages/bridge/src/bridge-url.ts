/**
 * 浏览器扩展 bridge 的 WebSocket URL 从哪来：当前页面的 location，或者
 * 发现（discovery）响应。设置项那一行与测试共用同一段逻辑。
 * @module dsh-browser-crossplatform/src/bridge-url
 */

import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@dsh-browser/protocol'

/** 重建一个 loopback 可用的 ws URL 所需的最小 Location 字段。 */
export interface BridgeLocationLike {
  protocol: string
  hostname: string
  port: string
  host: string
}

/**
 * 从 dsh web UI 所在页面构造 `ws(s)://…/ext/bridge`。
 * loopback 主机名会归一成 `127.0.0.1`，这样粘进 Chrome 扩展设置里的
 * 地址就是干净的。
 */
export function bridgeWsUrlFromLocation(
  location: BridgeLocationLike,
  bridgePath: string = BRIDGE_PATH,
): string {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname
  const host = location.port === '' ? hostname : `${hostname}:${location.port}`
  return `${wsProtocol}//${host}${bridgePath}`
}

/**
 * 能拿到发现端点就用它，否则退回按 `location` 重建的地址。
 * @param fetchImpl - 可注入的 fetch，默认用全局 fetch。
 * @param location - 页面 location，用来回退，也用来拼出相对的发现 URL。
 */
export async function resolveBridgeWsUrl(
  location: BridgeLocationLike & { origin?: string },
  fetchImpl: typeof fetch = fetch,
  bridgeConfigPath: string = BRIDGE_CONFIG_PATH,
): Promise<string> {
  const fallback = bridgeWsUrlFromLocation(location)
  try {
    const base = location.origin ?? `${location.protocol}//${location.host}`
    const response = await fetchImpl(`${base}${bridgeConfigPath}`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return fallback
    const body = await response.json() as { wsUrl?: unknown }
    if (typeof body.wsUrl === 'string' && (body.wsUrl.startsWith('ws://') || body.wsUrl.startsWith('wss://'))) {
      return body.wsUrl
    }
  } catch {
    // 发现只是尽力而为：设置项那一行照样显示重建出来的 URL。
  }
  return fallback
}
