// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ImageCache } from '../src/background/image-cache.ts'

describe('ImageCache', () => {
  it('remembers a description and stops asking for that image', () => {
    const cache = new ImageCache()
    expect(cache.shouldAttempt('logo')).toBe(true)
    cache.set('logo', '蓝色圆形标志，内有白色字母 A', 'desktop')
    expect(cache.get('logo')).toEqual({ desc: '蓝色圆形标志，内有白色字母 A', via: 'desktop' })
    expect(cache.shouldAttempt('logo')).toBe(false)
    expect(cache.size).toBe(1)
  })

  it('never retries an image that cannot be read in this session', () => {
    const cache = new ImageCache()
    cache.noteFailure('blob-1', true)
    expect(cache.shouldAttempt('blob-1')).toBe(false)
    // 持久不靠计数：再多快照也不能让一个 blob URL 变得可读。
    cache.noteFailure('blob-1', true)
    expect(cache.shouldAttempt('blob-1')).toBe(false)
  })

  it('retries a transient failure up to the attempt limit', () => {
    const cache = new ImageCache(200, 2)
    cache.noteFailure('flaky', false)
    expect(cache.shouldAttempt('flaky')).toBe(true)
    cache.noteFailure('flaky', false)
    expect(cache.shouldAttempt('flaky')).toBe(false)
  })

  it('clears failure state once the image is described', () => {
    const cache = new ImageCache(200, 1)
    cache.noteFailure('later', false)
    expect(cache.shouldAttempt('later')).toBe(false)
    // 仍然到达的描述（另一个标签页认出了它）必须胜出。
    cache.set('later', '一台笔记本电脑')
    expect(cache.get('later')?.desc).toBe('一台笔记本电脑')
  })

  it('evicts the oldest description past the bound', () => {
    const cache = new ImageCache(2, 2)
    cache.set('a', 'A')
    cache.set('b', 'B')
    cache.set('c', 'C')
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('c')?.desc).toBe('C')
  })

  it('reports counts for the panel', () => {
    const cache = new ImageCache()
    cache.set('a', 'A')
    cache.noteFailure('b', true)
    cache.noteFailure('c', false)
    expect(cache.stats()).toEqual({ described: 1, unavailable: 1, retrying: 1 })
  })

  it('clears everything on request', () => {
    const cache = new ImageCache()
    cache.set('a', 'A')
    cache.noteFailure('b', true)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.shouldAttempt('b')).toBe(true)
    expect(cache.stats()).toEqual({ described: 0, unavailable: 0, retrying: 0 })
  })

  describe('persistence', () => {
    it('carries descriptions and failures across a worker restart', () => {
      // Chrome 可能在两次工具调用之间停掉 worker；没有这段逻辑，那个
      // 唯一能实测缩短识别耗时的杠杆，就得指望
      // 这件事不发生。
      const first = new ImageCache()
      first.set('a', '一只蓝黑相间的豆娘', 'desktop')
      first.noteFailure('b', true, 'vision-unclear')
      first.noteFailure('c', false)

      const restarted = new ImageCache()
      expect(restarted.restore(first.snapshot())).toBe(true)
      expect(restarted.get('a')).toEqual({ desc: '一只蓝黑相间的豆娘', via: 'desktop' })
      expect(restarted.shouldAttempt('a')).toBe(false)
      expect(restarted.failureOf('b')).toBe('vision-unclear')
      expect(restarted.shouldAttempt('b')).toBe(false)
      // 允许的两次瞬时失败里的一次：还值得再试。
      expect(restarted.shouldAttempt('c')).toBe(true)
    })

    it('discards a snapshot it cannot believe rather than half-restoring one', () => {
      const cache = new ImageCache()
      expect(cache.restore(null)).toBe(false)
      expect(cache.restore('nope')).toBe(false)
      expect(cache.restore({ descriptions: 'nope', failureCounts: 7 })).toBe(false)
      expect(cache.restore({ descriptions: [['a']], failureCounts: [] })).toBe(false)
      expect(cache.size).toBe(0)
      // 一堆不可信的条目里，那个可信的会被留下。
      expect(cache.restore({
        descriptions: [['a', { desc: 'ok', via: 'desktop' }], ['b', { nope: true }]],
        failureCounts: [['c', 1], ['d', 'x']],
      })).toBe(true)
      expect(cache.get('a')).toEqual({ desc: 'ok', via: 'desktop' })
      expect(cache.get('b')).toBeUndefined()
      expect(cache.stats()).toMatchObject({ described: 1, retrying: 1 })
    })

    it('tells its host after every change, so nothing has to poll', () => {
      const seen: number[] = []
      const cache = new ImageCache(200, 2, (source) => { seen.push(source.size) })
      cache.set('a', 'x', 'desktop')
      cache.noteFailure('b', true, 'vision-unclear')
      cache.clear()
      expect(seen).toEqual([1, 1, 0])
    })

    it('bounds the failure tables, which only shrink when an image later succeeds', () => {
      // 描述从一开始就有上限；两张失败映射表却没有，而
      // 其中每一条都属于最终要写到磁盘上的载荷。
      const cache = new ImageCache(3, 2)
      for (let i = 0; i < 10; i += 1) cache.noteFailure(`transient-${String(i)}`, false)
      for (let i = 0; i < 10; i += 1) cache.noteFailure(`permanent-${String(i)}`, true, 'load-failed')
      expect(cache.stats()).toEqual({ described: 0, unavailable: 3, retrying: 3 })
      // 最新的留下来；被上限丢掉的是最旧的。
      expect(cache.failureOf('permanent-9')).toBe('load-failed')
      expect(cache.failureOf('permanent-0')).toBeUndefined()
      expect(cache.shouldAttempt('transient-9')).toBe(true)
    })

    it('applies the bound to a snapshot written before it existed', () => {
      const cache = new ImageCache(2, 2)
      expect(cache.restore({
        descriptions: [],
        failureCounts: [['a', 1], ['b', 1], ['c', 1]],
        permanentFailures: [['x', 'load-failed'], ['y', 'load-failed'], ['z', 'load-failed']],
      })).toBe(true)
      expect(cache.stats()).toEqual({ described: 0, unavailable: 2, retrying: 2 })
    })

    it('restores a snapshot that carries only permanent failures', () => {
      // 「这里没有可信内容」这项检查以前只看描述和计数，
      // 所以一个只装着已结算失败的存储会被悄悄丢掉。
      const cache = new ImageCache()
      expect(cache.restore({
        descriptions: [],
        failureCounts: [],
        permanentFailures: [['x', 'load-failed']],
      })).toBe(true)
      expect(cache.failureOf('x')).toBe('load-failed')
    })
  })
})
