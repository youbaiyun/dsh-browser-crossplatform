import { describe, expect, it } from 'vitest'
import { extensionOrigin, isLoopbackAddress, isTrustedExtensionOrigin } from '../src/server.ts'

/**
 * 免 token 的 loopback 通道背后那两个纯谓词。
 *
 * 它们与 `server.spec.ts` 里的 socket 测试分开做单元测试，这样以后改动谓词时，
 * 失败会在这里带着精确的原因出现，而不是只表现为一次莫名通过的认证连接。
 */
const EXT_ID = 'test-extension-id'
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`
/** 同一台机器上的另一个扩展：scheme 相同，身份不同。 */
const OTHER_EXT_ORIGIN = 'chrome-extension://some-other-installed-extension'

describe('isLoopbackAddress', () => {
  it('accepts every IPv4/IPv6 loopback spelling and nothing else', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(address)).toBe(true)
    }
    for (const address of [undefined, '', '127.0.0.2', '192.168.1.5', '::2', 'localhost']) {
      expect(isLoopbackAddress(address as string | undefined)).toBe(false)
    }
  })
})

describe('isTrustedExtensionOrigin', () => {
  it('matches one named extension and rejects the scheme alone', () => {
    expect(extensionOrigin(EXT_ID)).toBe(EXT_ORIGIN)
    expect(isTrustedExtensionOrigin(EXT_ORIGIN, EXT_ID)).toBe(true)
    // 这个谓词的全部要点：别的扩展不是这一个。
    expect(isTrustedExtensionOrigin(OTHER_EXT_ORIGIN, EXT_ID)).toBe(false)
    expect(isTrustedExtensionOrigin('chrome-extension://', EXT_ID)).toBe(false)
    expect(isTrustedExtensionOrigin(undefined, EXT_ID)).toBe(false)
    // 一个只是开头像真 Origin 的字符串也不能通过。
    expect(isTrustedExtensionOrigin(`${EXT_ORIGIN}.evil`, EXT_ID)).toBe(false)
  })

  it('trusts nothing when the configured id is empty', () => {
    expect(isTrustedExtensionOrigin(EXT_ORIGIN, '')).toBe(false)
  })
})
