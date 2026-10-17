/**
 * 单个浏览器 tab 里的 frame 发现和预算分配。
 *
 * frame id 标识一个 frame 槽位，是面向模型的 `(frame, index)` 元素地址里负责路由的
 * 那一半。它能跨导航活下来，所以安全检查额外把元素 id 和消息投递绑到了 `documentId` 上。
 * 元素 id 始终是各个 content script 局部的，所以某个 iframe 里重渲染一次，
 * 不会让页面其余部分那些本来就稳定的 id 失效。
 *
 * @module
 */

import type { ContentBudget } from './tools.ts'

/** 一个 tab 里活着的文档 frame。主 frame 的 id 恒为 0。 */
export interface TabFrame {
  frameId: number
  parentFrameId: number
  documentId?: string
  url: string
}

/** 各个 frame 自己的限额，加起来绝不超过协商好的 tab 预算。 */
export interface FrameBudget extends ContentBudget {}

const MAIN_FRAME_SHARE = 0.8

/**
 * 找出所有 frame；webNavigation 用不了、或者 tab 正处在两次导航之间时，退回主 frame。
 */
export async function listTabFrames(tabId: number, mainUrl: string | undefined): Promise<TabFrame[]> {
  try {
    const discovered = await chrome.webNavigation.getAllFrames({ tabId })
    if (discovered !== null && discovered !== undefined && discovered.length > 0) {
      return sortTabFrames(discovered.map((frame) => ({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        documentId: frame.documentId,
        url: frame.url,
      })))
    }
  } catch {
    // 导航期间，或者较老的测试/浏览器环境里拿不到 frame 树时，
    // 光靠一条主 frame 消息也还能给出有用的结果。
  }
  return [{ frameId: 0, parentFrameId: -1, url: mainUrl ?? '' }]
}

/** 让父 frame 排在子 frame 前面，而且不在每次比较时重建 frame 图。 */
export function sortTabFrames(frames: TabFrame[]): TabFrame[] {
  const parents = new Map(frames.map((frame) => [frame.frameId, frame.parentFrameId]))
  const depths = new Map<number, number>()
  for (const frame of frames) depths.set(frame.frameId, frameDepth(frame.frameId, parents))
  return [...frames].sort((a, b) => depths.get(a.frameId)! - depths.get(b.frameId)! || a.frameId - b.frameId)
}

function frameDepth(frameId: number, parents: Map<number, number>): number {
  const visited = new Set<number>()
  let depth = 0
  let parent = parents.get(frameId) ?? -1
  while (parent !== -1 && !visited.has(parent)) {
    visited.add(parent)
    depth += 1
    parent = parents.get(parent) ?? -1
  }
  return depth
}

/** 预算的 80% 给主文档，剩下的再精确切分。 */
export function allocateFrameBudgets(frames: TabFrame[], budget: ContentBudget): Map<number, FrameBudget> {
  if (frames.length <= 1) return new Map([[frames[0]?.frameId ?? 0, { ...budget }]])

  const mainFrame = frames.find((frame) => frame.frameId === 0) ?? frames[0]!
  const childFrames = frames.filter((frame) => frame !== mainFrame)
  const childIndex = new Map(childFrames.map((frame, index) => [frame.frameId, index]))
  const chars = allocateDimension(budget.maxChars, childFrames.length)
  const items = allocateDimension(budget.maxItems, childFrames.length)

  return new Map(frames.map((frame) => [
    frame.frameId,
    frame === mainFrame
      ? { maxChars: chars.main, maxItems: items.main }
      : {
          maxChars: chars.children[childIndex.get(frame.frameId)!]!,
          maxItems: items.children[childIndex.get(frame.frameId)!]!,
        },
  ]))
}

function allocateDimension(total: number, childCount: number): { main: number; children: number[] } {
  const boundedTotal = Math.max(0, Math.floor(total))
  const main = Math.min(boundedTotal, Math.max(1, Math.floor(boundedTotal * MAIN_FRAME_SHARE)))
  const remaining = boundedTotal - main
  const perChild = Math.floor(remaining / childCount)
  const remainder = remaining % childCount
  return {
    main,
    children: Array.from({ length: childCount }, (_, index) => perChild + (index < remainder ? 1 : 0)),
  }
}

/** 稳定键，用来在两次 delta 快照之间发现 frame 导航过。 */
export function frameDocumentKey(frame: TabFrame): string {
  return frame.documentId ?? frame.url
}

/** 给人看的 origin 标签；不支持/不透明的 URL 也得一眼分得出。 */
export function frameOrigin(frame: TabFrame): string {
  try {
    return new URL(frame.url).origin
  } catch {
    return frame.url === '' ? '(unknown)' : frame.url
  }
}
