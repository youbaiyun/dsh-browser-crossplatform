/**
 * 带标注的主内容渲染：页面文本里每张图片的位置都留一个标记。
 *
 * 快照是 content script 同步渲染出来的，而描述要等好几秒之后才由模型送到。
 * 所以描述没法在文本里诞生——那就让文本在每张图片的位置带一个标记，
 * background 在文本抵达模型之前把标记填上。标记格式和填充过程都在 `markers.ts`，
 * 因为 background 必须和这个文件逐字节一致。
 *
 * 渲染刻意做成混合式：只遍历通向图片的那些分支，其他子树整块用 `innerText` 读。
 * 全都遍历的话，就得拿浏览器自己的文本质量，去换模型在这个粒度上并不需要的位置信息。
 *
 * @module
 */

import { elementText } from './extract.ts'
import { escapeMarkers, imageMarker } from '../markers.ts'

/**
 * 在每张图片的位置渲染元素文本，并带上一个标记。
 *
 * 没有图片时这就是普通渲染——遍历找不到任何要跟随的分支，于是整块读根节点——
 * 所以不含图片的页面走的还是它一直走的那条代码路径。空白折叠方式和普通读取完全一致，
 * 所以标注文本只是同一段文本加上标记，不是形状不同的另一份文档。
 *
 * 剥离是无条件的，哪怕没有任何东西要标：页面没有图片时，
 * 不剥的话伪造的标记就会成为提示里唯一的那一个。
 *
 * @param root - 要渲染的内容根节点。
 * @param indexOf - 图片元素到清单编号的映射。
 * @returns 标注后的文本。
 */
export function annotatedText(root: Element, indexOf: ReadonlyMap<Element, number>): string {
  // 必须遍历的分支：每个被标记元素的所有祖先。靠这个集合做成员判断，
  // 遍历量才跟图片数量成正比，而不是跟 DOM 成正比。
  const walked = new Set<Element>()
  for (const element of indexOf.keys()) {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) walked.add(parent)
  }

  const out: string[] = []
  render(root, walked, indexOf, out)
  return out.join('').replace(/\s+/g, ' ').trim()
}

function render(
  node: Node,
  walked: ReadonlySet<Element>,
  indexOf: ReadonlyMap<Element, number>,
  out: string[],
): void {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element
    const index = indexOf.get(element)
    if (index !== undefined) {
      out.push(imageMarker(index))
      return
    }
    if (!walked.has(element)) {
      // 整块读，但照样要剥离：没标记的子树和其他页面文本没两样，
      // 而伪造的标记正是这里要防的。
      out.push(escapeMarkers(elementText(element)))
      return
    }
    for (const child of element.childNodes) render(child, walked, indexOf, out)
    return
  }
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(escapeMarkers((node as Text).data))
  }
}
