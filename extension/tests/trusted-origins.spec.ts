// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
  originMatchesTrusted,
} from '../src/security/trusted-origins.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'

function action(overrides: Partial<ApprovalPrompt> = {}): ApprovalPrompt {
  return {
    kind: 'action',
    action: 'browser_click',
    summary: 'click',
    origins: ['https://app.example.com'],
    canTrust: true,
    ...overrides,
  }
}

describe('normalizeTrustedOrigin', () => {
  it('canonicalizes exact origins and HTTPS wildcard aliases', () => {
    expect(normalizeTrustedOrigin(' https://Example.com/path ')).toBe('https://example.com')
    expect(normalizeTrustedOrigin('*.Example.com')).toBe('https://*.example.com')
    expect(normalizeTrustedOrigin('https://%2A.Example.com')).toBe('https://*.example.com')
  })

  it('preserves explicit wildcard schemes and non-default ports', () => {
    expect(normalizeTrustedOrigin('http://*.example.com')).toBe('http://*.example.com')
    expect(normalizeTrustedOrigin('https://*.example.com:8443')).toBe('https://*.example.com:8443')
  })

  it('rejects malformed or overly broad wildcard entries', () => {
    expect(normalizeTrustedOrigin('https://*.example.com/path')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.localhost')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://user:pass@*.example.com')).toBeUndefined()
    // 光秃秃的公共后缀不是任何人能控制的域名。它仍被接受为
    // 通配根，因为扩展刻意不内置公共后缀表
    //（那要占掉控制条约 100 KB）：`*.co.uk` 只覆盖
    // `co.uk` 本身和它自己的子域，而这正是用户
    // 输入的东西，何况 Chrome 本来就会把 `co.uk` 交给注册局。
    expect(normalizeTrustedOrigin('https://*.co.uk')).toBe('https://*.co.uk')
  })

  it('allows registrable and narrower wildcard roots', () => {
    expect(normalizeTrustedOrigin('https://*.example.co.uk')).toBe('https://*.example.co.uk')
    expect(normalizeTrustedOrigin('https://*.user.github.io')).toBe('https://*.user.github.io')
    expect(normalizeTrustedOrigin('https://*.api.example.com')).toBe('https://*.api.example.com')
  })

  it('keeps a multi-label host out of the single-label wildcard case', () => {
    // `*.com` 会覆盖所有 .com 站点；双标签规则拒了它，
    // 同时又仍接受普通的双标签域名。
    expect(normalizeTrustedOrigin('https://*.com')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.127.0.0.1')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.example.com')).toBe('https://*.example.com')
  })
})

describe('originMatchesTrusted', () => {
  const trusted = ['https://*.example.com', 'https://secure.example.net:8443']

  it('matches the wildcard base domain and proper subdomains', () => {
    expect(originMatchesTrusted('https://example.com', trusted)).toBe(true)
    expect(originMatchesTrusted('https://api.example.com', trusted)).toBe(true)
    expect(originMatchesTrusted('https://notexample.com', trusted)).toBe(false)
  })

  it('does not cross scheme or port boundaries', () => {
    expect(originMatchesTrusted('http://api.example.com', trusted)).toBe(false)
    expect(originMatchesTrusted('https://api.example.com:8443', trusted)).toBe(false)
    expect(originMatchesTrusted('https://secure.example.net:8443', trusted)).toBe(true)
  })
})

describe('actionCoveredByTrustedOrigins', () => {
  const trusted = ['https://*.example.com']

  it('covers stable actions and fully known cross-origin navigation', () => {
    expect(actionCoveredByTrustedOrigins(action(), trusted)).toBe(true)
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_navigate',
      origins: ['https://app.example.com', 'https://docs.example.com'],
      canTrust: false,
    }), trusted)).toBe(true)
  })

  it('fails closed for history and invalid navigation with unknown destinations', () => {
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_back',
      canTrust: false,
    }), trusted)).toBe(false)
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_navigate',
      canTrust: false,
    }), trusted)).toBe(false)
  })

  it('requires every known navigation origin to be trusted', () => {
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_navigate',
      origins: ['https://app.example.com', 'https://bank.example.net'],
      canTrust: false,
    }), trusted)).toBe(false)
  })
})
