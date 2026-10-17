import type { ApprovalPrompt } from './approval.ts'

/**
 * 把精确 origin 或通配 origin 规范化，供持久化存储使用。
 * 裸通配符是 HTTPS 的别名；显式写出的 scheme 和端口会保留它们的限定范围。
 */
export function normalizeTrustedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const wildcard = normalizeWildcard(trimmed)
  if (wildcard !== undefined) return wildcard
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && !url.hostname.includes('*')
      ? url.origin
      : undefined
  } catch {
    return undefined
  }
}

/** 某个具体的 web origin 有没有被某条精确或通配条目覆盖。 */
export function originMatchesTrusted(origin: string, trusted: Iterable<string>): boolean {
  let parsedOrigin: URL | undefined
  for (const entry of trusted) {
    if (entry === origin) return true
    const wildcard = parseWildcard(entry)
    if (wildcard === undefined) continue
    try {
      parsedOrigin ??= new URL(origin)
    } catch {
      return false
    }
    if (parsedOrigin.protocol !== wildcard.protocol || parsedOrigin.port !== wildcard.port) continue
    const host = parsedOrigin.hostname.toLowerCase()
    if (host === wildcard.hostname || host.endsWith(`.${wildcard.hostname}`)) return true
  }
  return false
}

/**
 * 只有某个动作的完整目标边界已知，才跳过它的提示。
 * 跨域 browser_navigate 会列出两个 origin；历史导航和无效 URL 刻意保持不可信，
 * 因为它们的目标没有被表示出来。
 */
export function actionCoveredByTrustedOrigins(
  prompt: ApprovalPrompt,
  ...trustedCollections: Iterable<string>[]
): boolean {
  if (prompt.kind !== 'action' || prompt.origins.length === 0) return false
  const hasKnownBoundary = prompt.canTrust
    || (prompt.action === 'browser_navigate' && prompt.origins.length > 1)
    || (prompt.action === 'browser_open_tab' && prompt.origins.length === 1)
  if (!hasKnownBoundary) return false
  return prompt.origins.every((origin) =>
    trustedCollections.some((trusted) => originMatchesTrusted(origin, trusted)))
}

interface WildcardOrigin {
  protocol: 'http:' | 'https:'
  hostname: string
  port: string
}

function normalizeWildcard(value: string): string | undefined {
  const decodedStar = value.replace(/^((?:https?:\/\/)?)(?:\*|%2a)\./i, '$1*.')
  if (!/^(?:https?:\/\/)?\*\./i.test(decodedStar)) return undefined
  const candidate = /^https?:\/\//i.test(decodedStar) ? decodedStar : `https://${decodedStar}`
  const placeholder = candidate.replace(/^(https?:\/\/)\*\./i, '$1wildcard.')
  try {
    const url = new URL(placeholder)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const hostname = url.hostname.toLowerCase().replace(/^wildcard\./, '')
    if (!isDomainName(hostname)) return undefined
    return `${url.protocol}//*.${hostname}${url.port === '' ? '' : `:${url.port}`}`
  } catch {
    return undefined
  }
}

function parseWildcard(value: string): WildcardOrigin | undefined {
  if (!/^https?:\/\/\*\./i.test(value)) return undefined
  const placeholder = value.replace(/^(https?:\/\/)\*\./i, '$1wildcard.')
  try {
    const url = new URL(placeholder)
    const hostname = url.hostname.toLowerCase().replace(/^wildcard\./, '')
    if (!isDomainName(hostname)) return undefined
    return { protocol: url.protocol as 'http:' | 'https:', hostname, port: url.port }
  } catch {
    return undefined
  }
}

/**
 * 通配符的主机部分有没有可能是一个可注册域名。
 *
 * 要求两个格式正确的标签，这正是这里以前那次 Public-Suffix-List 查询实际在做的事：
 * 单个标签（比如内网主机 `wiki`）和 IP 地址都可能是真实主机，所以不能让 `*.`
 * 去认领它们。后缀列表现在不再查了——匹配 `*.co.uk` 才需要它，
 * 而 Chrome 本来就把 `co.uk` 交给它自己的注册表处理，所以公共后缀不是谁能控制的域名。
 * 不查这一步，就能让一棵约 100 KB 的后缀 trie 不进扩展。
 */
function isDomainName(hostname: string): boolean {
  const labels = hostname.split('.')
  return labels.length >= 2
    && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}
