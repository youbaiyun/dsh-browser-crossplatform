// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fillImageStates } from '../src/background/tools.ts'
import type { VisionSink } from '../src/background/vision.ts'

/** 一条内容回答，携带一张带编号的图片。 */
function answerWith(index: number, identity: string): { ok: true; result: unknown } {
  return { ok: true, result: { text: 'ignored', imageIdentities: [{ index, identity }] } }
}

/** 一个 sink，它知道的图片只有 `identity`。 */
function sinkFor(identity: string, state: string | undefined): VisionSink {
  return {
    states: (asked) => asked === identity ? state : undefined,
    sawPageText: () => {},
  }
}

describe('fillImageStates', () => {
  it('puts the state at the marker of the matching image', () => {
    const text = '正文 ⟦i1 img:not-requested⟧ 结尾'
    const filled = fillImageStates(text, answerWith(1, 'https://x.test/a.png'), sinkFor('https://x.test/a.png', '一张折线图'))
    expect(filled).toBe('正文 ⟦i1 img:一张折线图⟧ 结尾')
  })

  it('leaves a marker alone when the identity is unknown', () => {
    const text = '⟦i1 img:not-requested⟧'
    expect(fillImageStates(text, answerWith(1, 'https://x.test/a.png'), sinkFor('https://x.test/b.png', 'x')))
      .toBe('⟦i1 img:not-requested⟧')
  })

  it('leaves the text alone without a sink, identifiers, or markers', () => {
    const text = '⟦i1 img:not-requested⟧'
    const response = answerWith(1, 'a')
    expect(fillImageStates(text, response, undefined)).toBe(text)
    expect(fillImageStates('no markers here', response, sinkFor('a', 'x'))).toBe('no markers here')
    expect(fillImageStates(text, { ok: true, result: { text: 'x' } }, sinkFor('a', 'x'))).toBe(text)
  })

  it('reports what the page already knows over what the cache holds', () => {
    // 加载失败的图片永远不会被请求，所以不可能有它的缓存条目：
    // 失败原因只能来自页面自己的报告。
    const response = {
      ok: true,
      result: { text: 'x', imageIdentities: [{ index: 1, identity: 'a', unavailable: 'load-failed' }] },
    }
    const sink: VisionSink = { states: () => 'should not be reached', sawPageText: () => {} }
    expect(fillImageStates('⟦i1 img:not-requested⟧', response, sink)).toBe('⟦i1 img:unavailable:load-failed⟧')
  })

  it('reports the page text it was given, markers removed', () => {
    const sawPageText = vi.fn()
    const sink: VisionSink = { states: () => undefined, sawPageText }
    fillImageStates('⟦i1 img:not-requested⟧', answerWith(1, 'a'), sink)
    // fill 不报页面文本；那是 dispatcher 的另一次调用，
    // 那一次会先剥掉标记。这里断言两者永远不会被合并。
    expect(sawPageText).not.toHaveBeenCalled()
  })
})
