// @vitest-environment jsdom

/**
 * 面板为某一轮（turn）展示的任务列表。
 *
 * 有两个行为很重要，也都容易做错：模型还在流式输出清单时，
 * 哪个版本该胜出，以及用户读到的列表
 * 要和模型写下的清单一致。
 */

import { describe, expect, it } from 'vitest'
import { parsePlan } from '@dsh-browser/protocol'

import { preferPlan } from '../control/main.ts'

const plan = (text: string) => parsePlan(text)

describe('preferPlan', () => {
  it('keeps the longer list while a shorter re-emission streams in', () => {
    // 模型会重写整份清单；而重写的最初几帧只带开头几行。
    // 若采用「最新者胜出」，每次进度更新都会让列表
    // 肉眼可见地被截断。
    const complete = plan('- [ ] one\n- [ ] two\n- [ ] three')
    const partial = plan('- [ ] one')
    expect(preferPlan(complete, partial)?.tasks).toHaveLength(3)
    expect(preferPlan(partial, complete)?.tasks).toHaveLength(3)
  })

  it('takes the newer copy when both are the same length, because it carries progress', () => {
    const before = plan('- [ ] one\n- [ ] two')
    const after = plan('- [x] one\n- [>] two')
    const chosen = preferPlan(before, after)
    expect(chosen?.tasks.map((task) => task.status)).toEqual(['done', 'active'])
    // ……并且绝不把已完成的任务回退成 pending。
    expect(preferPlan(after, before)?.tasks.map((task) => task.status)).toEqual(['done', 'active'])
  })

  it('ignores a message with no checklist and survives having nothing yet', () => {
    const only = plan('- [ ] one\n- [ ] two')
    expect(preferPlan(only, null)).toBe(only)
    expect(preferPlan(null, null)).toBeNull()
    expect(preferPlan(only, plan('just prose'))).toBe(only)
  })
})
