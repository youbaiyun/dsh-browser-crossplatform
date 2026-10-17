import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, planProgress, renderPlan } from '../src/index.ts'

test('reads the checklist the model was asked to write', () => {
  const plan = parsePlan([
    'I will work through this:',
    '- [x] List the open tabs',
    '- [>] Open bilibili in a new tab',
    '- [ ] Read the page',
  ].join('\n'))
  assert.ok(plan)
  assert.deepEqual(plan.tasks.map((task) => [task.text, task.status]), [
    ['List the open tabs', 'done'],
    ['Open bilibili in a new tab', 'active'],
    ['Read the page', 'pending'],
  ])
  assert.equal(plan.activeId, 1)
  assert.equal(plan.complete, false)
})

test('a failure is terminal, and every task finishing means the plan is complete', () => {
  const plan = parsePlan('- [x] Open the page\n- [!] Download the video')
  assert.ok(plan)
  assert.equal(plan.complete, true)
  assert.equal(plan.tasks[1]?.status, 'failed')
  // 每个框落定之后，就没有任何东西还在进行中。
  assert.equal(plan.activeId, null)
})

test('accepts numbered and bare-bracket items, because the box is the contract', () => {
  const numbered = parsePlan('1. [x] First\n2. [ ] Second')
  assert.equal(numbered?.tasks.length, 2)
  const bare = parsePlan('[x] First\n[ ] Second')
  assert.equal(bare?.tasks.length, 2)
  const capital = parsePlan('- [X] Done')
  assert.equal(capital?.tasks[0]?.status, 'done')
})

test('a list with no boxes counts only under a heading that announces a plan', () => {
  // 没有这个标题，它就是一段普通的项目符号回答，而不是任务表。
  assert.equal(parsePlan('- one thing\n- another thing'), null)
  const titled = parsePlan('## 任务清单\n- 打开标签页\n- 读取页面')
  assert.ok(titled)
  assert.deepEqual(titled.tasks.map((task) => task.status), ['pending', 'pending'])
  // 单项不算列表；大白话不是任务表。
  assert.equal(parsePlan('## Plan\n- only one'), null)
  assert.equal(parsePlan('## Plan\njust a sentence'), null)
})

test('prose after a loose list is not swallowed into it', () => {
  const plan = parsePlan('## Plan\n- first\n- second\n\nThat is the whole job.')
  assert.deepEqual(plan?.tasks.map((task) => task.text), ['first', 'second'])
})

test('no checklist means no plan, and empty text is not a plan', () => {
  assert.equal(parsePlan(''), null)
  assert.equal(parsePlan('Just a reply, no list at all.'), null)
  // 框里什么都没有，那不算任务。
  assert.equal(parsePlan('- [ ]\n- [x]'), null)
})

test('a plan survives a round trip through its rendering', () => {
  const original = parsePlan('- [x] one\n- [>] two\n- [!] three\n- [ ] four')
  assert.ok(original)
  const again = parsePlan(renderPlan(original))
  assert.deepEqual(again?.tasks, original.tasks)
})

test('counts each state for the progress summary', () => {
  const plan = parsePlan('- [x] a\n- [x] b\n- [>] c\n- [!] d\n- [ ] e')
  assert.ok(plan)
  assert.deepEqual(planProgress(plan), { done: 2, failed: 1, active: 1, pending: 1, total: 5 })
})

test('two tasks in progress do not nominate one, rather than picking arbitrarily', () => {
  const plan = parsePlan('- [>] a\n- [>] b')
  assert.equal(plan?.activeId, null)
})
