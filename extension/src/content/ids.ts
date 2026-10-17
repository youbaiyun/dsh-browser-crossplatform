/**
 * 交互式清单的稳定元素编号。
 *
 * 编号就是模型的寻址方案（“点击 7”），所以只要元素本身还活着，
 * 它们就得在反复快照之间保持稳定：id 对每个元素只发一次
 * （WeakMap），只有元素集合被重建时才重新编号。
 * 同时还会写一个 `data-dsh-el` 属性，这样这些 id 从外面也看得见。
 *
 * @module
 */

/** 写在每个编入清单的元素上的属性（编号从外面看得见）。 */
const ID_ATTRIBUTE = 'data-dsh-el'

/**
 * 稳定的元素 → id 注册表。每个 content script 生命周期一个实例。
 */
export class ElementIds {
  private readonly idByElement = new WeakMap<Element, number>()
  private readonly elementById = new Map<number, Element>()
  private nextId = 1

  /**
   * 让注册表跟当前元素集合对齐：丢掉已经消失的元素的 id，
   * 给新来的元素发新 id。
   * @param elements - 当前交互式清单（文档顺序）。
   * @returns 新增和移除的元素数量。
   */
  assign(elements: Element[]): { added: number; removed: number } {
    const seen = new Set(elements)
    let removed = 0
    for (const [id, el] of this.elementById) {
      if (!seen.has(el)) {
        this.elementById.delete(id)
        this.idByElement.delete(el)
        removed += 1
      }
    }
    let added = 0
    for (const el of elements) {
      if (!this.idByElement.has(el)) {
        const id = this.nextId
        this.nextId += 1
        this.idByElement.set(el, id)
        this.elementById.set(id, el)
        el.setAttribute(ID_ATTRIBUTE, String(id))
        added += 1
      }
    }
    return { added, removed }
  }

  /**
   * 查一个元素的稳定 id。
   * @param el - 元素。
   * @returns 已分配的 id；没编入清单时为 undefined。
   */
  indexOf(el: Element): number | undefined {
    return this.idByElement.get(el)
  }

  /**
   * 按 id 找出对应的元素。
   * @param index - 清单编号。
   * @returns 那个元素；过期或已被移除时为 undefined。
   */
  elementByIndex(index: number): Element | undefined {
    return this.elementById.get(index)
  }
}
