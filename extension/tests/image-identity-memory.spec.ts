// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberedImageIdentities, rememberImageIdentities } from '../src/background/tools.ts'

/**
 * 后台记着每个图片编号曾经指向什么。
 *
 * 它存在的意义是：页面重新渲染之后才到的 describe 调用仍然能
 * 说出那张图是什么。值得钉住的规则，是那些一旦映射出错就会
 * 悄悄失败的部分：frame 是彼此独立的命名空间，而且一个长生命周期的 frame
 * 不能为每张图片无限地长编号下去。
 */
describe('remembered image identities', () => {
  beforeEach(() => {
    rememberedImageIdentities.clear()
  })

  it('remembers what a number pointed at', () => {
    rememberImageIdentities(7, 0, [{ index: 3, identity: 'https://example.com/a.png' }])
    expect(rememberedImageIdentities.get('7:0')?.get(3)).toBe('https://example.com/a.png')
  })

  it('keeps the same number in two frames apart', () => {
    // 元素索引是按 frame 分的命名空间，所以一张横跨标签页的映射会把一个
    // frame 的地址交给另一个。
    rememberImageIdentities(7, 0, [{ index: 3, identity: 'https://example.com/a.png' }])
    rememberImageIdentities(7, 4, [{ index: 3, identity: 'https://example.com/b.png' }])
    expect(rememberedImageIdentities.get('7:0')?.get(3)).toBe('https://example.com/a.png')
    expect(rememberedImageIdentities.get('7:4')?.get(3)).toBe('https://example.com/b.png')
  })

  it('keeps the same number in two tabs apart', () => {
    rememberImageIdentities(7, 0, [{ index: 1, identity: 'https://example.com/a.png' }])
    rememberImageIdentities(8, 0, [{ index: 1, identity: 'https://example.com/b.png' }])
    expect(rememberedImageIdentities.get('7:0')?.get(1)).toBe('https://example.com/a.png')
    expect(rememberedImageIdentities.get('8:0')?.get(1)).toBe('https://example.com/b.png')
  })

  it('learns nothing from a snapshot that numbered no images', () => {
    rememberImageIdentities(9, 0, [])
    expect(rememberedImageIdentities.has('9:0')).toBe(false)
  })

  it('stays bounded on a frame that has numbered thousands of images', () => {
    for (let index = 0; index < 700; index += 1) {
      rememberImageIdentities(11, 0, [{ index, identity: `https://example.com/${String(index)}.png` }])
    }
    const byNumber = rememberedImageIdentities.get('11:0')!
    expect(byNumber.size).toBeLessThanOrEqual(500)
    // 最新的是活动页面马上要被问到的那张；最旧的被淘汰。
    expect(byNumber.get(699)).toBe('https://example.com/699.png')
    expect(byNumber.has(0)).toBe(false)
  })

  it('bounds how many frames it remembers, since closed tabs never report back', () => {
    // 一个 frame 里编号数量的上限，管不了 frame 的数量：
    // 每个被快照过的标签页和 iframe 都会加进一个没人移除的键。
    for (let tab = 1; tab <= 200; tab += 1) {
      rememberImageIdentities(tab, 0, [{ index: 0, identity: `https://example.com/${String(tab)}.png` }])
    }
    expect(rememberedImageIdentities.size).toBe(64)
    expect(rememberedImageIdentities.has('200:0')).toBe(true)
    expect(rememberedImageIdentities.has('1:0')).toBe(false)
  })

  it('drops the frame that went longest without a snapshot, not the one opened first', () => {
    // 一个反复被快照的长生命周期标签页，正是 describe
    // 调用马上要引用的那个，所以它必须能在不断更新的 frame 洪流里活下来。
    rememberImageIdentities(1, 0, [{ index: 0, identity: 'https://example.com/keep.png' }])
    for (let tab = 2; tab <= 200; tab += 1) {
      rememberImageIdentities(tab, 0, [{ index: 0, identity: `https://example.com/${String(tab)}.png` }])
      rememberImageIdentities(1, 0, [{ index: 0, identity: 'https://example.com/keep.png' }])
    }
    expect(rememberedImageIdentities.size).toBeLessThanOrEqual(64)
    expect(rememberedImageIdentities.get('1:0')?.get(0)).toBe('https://example.com/keep.png')
  })
})
