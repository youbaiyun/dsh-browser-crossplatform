// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'

describe('ElementIds', () => {
  it('assigns stable ids across reconciles', () => {
    const ids = new ElementIds()
    const a = document.createElement('button')
    const b = document.createElement('button')
    ids.assign([a, b])
    const first = ids.indexOf(a)!
    expect(first).toBe(1)
    expect(ids.indexOf(b)).toBe(2)
    expect(a.getAttribute('data-dsh-el')).toBe('1')

    // 同一批元素再来一次：id 不变，没新增也没移除。
    expect(ids.assign([a, b])).toEqual({ added: 0, removed: 0 })
    expect(ids.indexOf(a)).toBe(first)
  })

  it('drops removed elements and appends ids to new ones', () => {
    const ids = new ElementIds()
    const a = document.createElement('button')
    const b = document.createElement('button')
    const c = document.createElement('button')
    ids.assign([a, b])
    const result = ids.assign([b, c])
    expect(result).toEqual({ added: 1, removed: 1 })
    expect(ids.indexOf(b)).toBe(2) // 稳定不变
    expect(ids.indexOf(c)).toBe(3) // 全新的 id，绝不重用刚释放的那个
    expect(ids.elementByIndex(1)).toBeUndefined()
  })

  it('resolves elements by index', () => {
    const ids = new ElementIds()
    const a = document.createElement('button')
    ids.assign([a])
    expect(ids.elementByIndex(ids.indexOf(a)!)).toBe(a)
    expect(ids.elementByIndex(99)).toBeUndefined()
  })
})
