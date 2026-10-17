// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

const BUDGET: SnapshotBudget = { maxItems: 12, maxForms: 5, maxChars: 6_000 }

/** 像快照那样填充 id 注册表，然后解析出一张图片。 */
async function resolveImage(html: string): Promise<ReturnType<typeof runAction>> {
  document.body.innerHTML = html
  const ids = new ElementIds()
  buildSnapshot(ids, { budget: BUDGET }, null)
  const image = document.querySelector('img, svg, video')!
  const index = ids.indexOf(image)
  if (index === undefined) throw new Error('the fixture image was not inventoried')
  return await runAction('browser_describe_image', { index }, { ids, budget: BUDGET })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('browser_describe_image', () => {
  it('uses the same identity the snapshot reported, or the cache never hits', async () => {
    // 两边各自独立算这个值：快照把它渲染进
    // 身份映射，describe 动作则带着它来提问。这里一旦漂移根本看不见——
    // 标记只会一直写着「not-requested」——所以要断言它。
    document.body.innerHTML = `
      <h2>本季度营收</h2>
      <img id="chart" src="data:image/png;base64,${'A'.repeat(40)}" alt="季度营收" style="width:64px;height:64px">
    `
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const reported = view.images[0]?.identity
    expect(reported).toBeDefined()

    const index = ids.indexOf(document.getElementById('chart')!)!
    const result = await runAction('browser_describe_image', { index }, { ids, budget: BUDGET })
    expect(result.image?.identity).toBe(reported)
  })

  it('resolves an image to its identity and page context', async () => {
    const result = await resolveImage(`
      <h2>本季度营收</h2>
      <figure><img src="/chart.png" alt="季度营收"><figcaption>营收趋势</figcaption></figure>
    `)
    expect(result.image).toEqual({
      identity: 'http://localhost:3000/chart.png',
      alt: '季度营收',
      near: '营收趋势',
      heading: '本季度营收',
      kind: 'content',
      src: 'http://localhost:3000/chart.png',
    })
    expect(result.text).toContain('Image')
  })

  it('names an image that is itself the click target of a link', async () => {
    // 页面自己的结构说明了这是哪一类图片，而这会改变
    // 答案该怎么解读。
    const result = await resolveImage('<a href="/offer"><img src="/banner.png" alt="促销"></a>')
    expect(result.image?.kind).toBe('link')
  })

  it('falls back to the element index for an image with no address', async () => {
    const result = await resolveImage('<svg width="100" height="60"><circle r="10" /></svg>')
    expect(result.image?.src).toBe('')
    expect(result.image?.identity).toMatch(/^el:\d+$/)
  })

  it('reports an image whose label is missing rather than inventing one', async () => {
    const result = await resolveImage('<img src="/photo.jpg">')
    expect(result.image?.alt).toBe('')
    expect(result.image?.near).toBe('')
  })

  it('refuses an index that is not an image', async () => {
    document.body.innerHTML = '<button>提交</button><img src="/a.png">'
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const button = ids.indexOf(document.querySelector('button')!)!
    await expect(runAction('browser_describe_image', { index: button }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('refuses a missing index before touching the page', async () => {
    const ids = new ElementIds()
    await expect(runAction('browser_describe_image', {}, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args' })
  })

  it('refuses an index the page no longer has', async () => {
    document.body.innerHTML = '<img src="/a.png">'
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    document.body.replaceChildren()
    await expect(runAction('browser_describe_image', { index: 999 }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('recovers the image by address after a re-render retires its index', async () => {
    // 注册表由 WeakMap 支撑，所以一次重新渲染就会换掉该 id
    // 所属的节点，模型记住的编号也跟着失效。图片
    // 还在那儿，而快照认作它身份的那个地址仍然
    // 指向它，所以这次调用应该能熬过页面自己的重绘。
    document.body.innerHTML = '<img src="/chart.png" alt="图表" style="width:64px;height:64px">'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = '<section><img src="/chart.png" alt="图表" style="width:64px;height:64px"></section>'
    buildSnapshot(ids, { budget: BUDGET }, null)
    expect(ids.elementByIndex(staleIndex)).toBeUndefined()

    const result = await runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET })
    expect(result.image?.src).toBe('http://localhost:3000/chart.png')
    expect(result.text).toContain('recovered by address')
  })

  it('still prefers the live index over the remembered address', async () => {
    // 这个提示只是兜底，不是覆盖：只要编号能解析成功就采纳，
    // 哪怕调用方同时传了一个会匹配到另一张图片的地址。
    document.body.innerHTML = '<img src="/a.png" style="width:64px"><img src="/b.png" style="width:64px">'
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const second = view.images[1]!

    const result = await runAction(
      'browser_describe_image',
      { index: second.index, identity: view.images[0]!.identity },
      { ids, budget: BUDGET },
    )
    expect(result.image?.src).toBe('http://localhost:3000/b.png')
    expect(result.text).not.toContain('recovered by address')
  })

  it('does not invent a recovery for an image that has no address', async () => {
    // 没有地址的图片就靠那个已经失效的编号来认，所以
    // 拿那个编号去「匹配」它，是在猜，不是在恢复。
    document.body.innerHTML = '<svg width="100" height="60"><circle r="10" /></svg>'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = '<div><svg width="100" height="60"><circle r="10" /></svg></div>'
    buildSnapshot(ids, { budget: BUDGET }, null)

    await expect(runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('names the numbers that still resolve when an index is gone', async () => {
    // 没有当前的编号，唯一能往前走的办法就是再做一次完整快照，
    // 而这正是索引化路径要避开的开销。
    document.body.innerHTML = `
      <img src="/a.png" style="width:64px;height:64px">
      <img src="/b.png" style="width:64px;height:64px">
    `
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const resolvable = ids.indexOf(document.querySelectorAll('img')[0]!)!

    await expect(runAction('browser_describe_image', { index: 999 }, { ids, budget: BUDGET }))
      .rejects.toThrow(new RegExp(`the page currently numbers images ${String(resolvable)}`))
  })

  it('says so plainly when the page numbers no images at all', async () => {
    document.body.innerHTML = '<button>提交</button>'
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)

    await expect(runAction('browser_describe_image', { index: 0 }, { ids, budget: BUDGET }))
      .rejects.toThrow(/the page currently numbers no images/)
  })

  it('refuses to recover when a remembered address matches more than one image', async () => {
    // 一个共享的 logo 或占位图会同时出现在许多图块上。取第一个
    // 匹配会把那个实例的 alt/near/heading 安到一张答案
    // 还没缓存的图片上——变成对错误图块的一段自信描述。
    const markup = `
      <figure><img src="/logo.png" alt="甲" style="width:64px;height:64px"><figcaption>第一处</figcaption></figure>
      <figure><img src="/logo.png" alt="乙" style="width:64px;height:64px"><figcaption>第二处</figcaption></figure>
    `
    document.body.innerHTML = markup
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = markup
    buildSnapshot(ids, { budget: BUDGET }, null)

    await expect(runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed' })
  })

  it('recovers when a remembered address matches exactly one image', async () => {
    // 同样是重新渲染，但地址是唯一的：这正是恢复机制要应对的场景。
    document.body.innerHTML = '<img src="/solo.png" alt="图" style="width:64px;height:64px">'
    const ids = new ElementIds()
    const first = buildSnapshot(ids, { budget: BUDGET }, null)
    const staleIndex = first.images[0]!.index
    const identity = first.images[0]!.identity

    document.body.innerHTML = '<section><img src="/solo.png" alt="图" style="width:64px;height:64px"></section>'
    buildSnapshot(ids, { budget: BUDGET }, null)

    const result = await runAction('browser_describe_image', { index: staleIndex, identity }, { ids, budget: BUDGET })
    expect(result.image?.src).toBe('http://localhost:3000/solo.png')
    expect(result.text).toContain('recovered by address')
  })
})
