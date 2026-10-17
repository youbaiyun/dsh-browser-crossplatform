/**
 * 一个 turn 正在推进的任务清单。
 *
 * 模型被要求在开启一个 turn 时先写出它接下来要执行的清单，并在推进过程中连勾选状态一起
 * 重新输出。这样旁观者能拿到工具日志给不了的三样东西：*整个*任务是什么、此刻在做哪一部
 * 分、任务做完没有。
 *
 * 格式就是普通的 markdown 清单——模型能稳定产出、读者也能一眼认出来的那种：
 *
 * ```text
 * - [ ] 列出当前打开的标签页
 * - [>] 在新标签页里打开 bilibili
 * - [x] 阅读页面
 * - [!] 下载视频（失败：需要登录）
 * ```
 *
 * 解析刻意宽容：方框才算契约，方框周围的东西（标题、项目符号、编号、一句开场白）都
 * 容忍。本模块是纯函数式的，契约因此可以由测试钉死，而不是指望模型守规矩。
 *
 * @module
 */

/** 一个任务处于什么状态。 */
export type PlanTaskStatus = 'pending' | 'active' | 'done' | 'failed'

/** 清单里的一行。 */
export interface PlanTask {
  /** 在一份 plan 内保持稳定：按位置分配，重新输出的列表才对得上。 */
  id: number
  /** 模型写下的任务原文，方框已经去掉。 */
  text: string
  status: PlanTaskStatus
}

/** 一整份清单，外加它是从什么推导出来的。 */
export interface Plan {
  tasks: PlanTask[]
  /** 是否每个任务都已到达终态。 */
  complete: boolean
  /** 正在进行的任务，仅当恰好有一个被标为 `active` 时。 */
  activeId: number | null
}

const BOX = /^\s*(?:[-*+]|\d+[.)])?\s*\[([ xX>!])\]\s*(.+?)\s*$/u
const LABELLED = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/u

/** 从方框字符得出状态。 */
function statusOf(box: string): PlanTaskStatus {
  switch (box) {
    case ' ':
      return 'pending'
    case '>':
      return 'active'
    case '!':
      return 'failed'
    default:
      return 'done'
  }
}

/**
 * 从一条 assistant 消息里读出清单。
 *
 * 按可信度排序，有两种形态算数：
 *
 * 1. **带方框的条目**——`- [ ]`、`- [x]`、`- [>]`、`- [!]`。模型把任务和它的状态一起
 *    给出，所以一次进度更新无非是把列表再写一遍。
 * 2. **一个方框都没有的裸列表**——位于提到 plan 或 tasks 的标题之下的编号或项目符号。
 *    每一项都是待办。之所以支持它，是因为一个把计划列出来却不带方框的模型，也应该
 *    产出一份看得见的任务清单，而不是什么都没有。
 *
 * @param text - 一条消息的 assistant 文本。
 * @returns 该 plan；文本里没有清单时返回 null。
 */
export function parsePlan(text: string): Plan | null {
  const lines = text.split('\n')
  const tasks: PlanTask[] = []
  let sawBox = false
  for (const line of lines) {
    const boxed = BOX.exec(line)
    if (boxed !== null) {
      const [, box, body] = boxed
      // 复选框是真实的任务，但复选框下面嵌的子列表是个提问，不是计划
      // ——只取一层，列表才读得下去。
      const task = (body ?? '').trim()
      if (task !== '') {
        sawBox = true
        tasks.push({ id: tasks.length, text: task, status: statusOf(box ?? ' ') })
      }
    }
  }

  if (!sawBox) {
    const loose = looseList(lines)
    if (loose === null) return null
    tasks.push(...loose.map((task, index) => ({ id: index, text: task, status: 'pending' as const })))
  }

  if (tasks.length === 0) return null
  const active = tasks.filter((task) => task.status === 'active')
  return {
    tasks,
    complete: tasks.every((task) => task.status === 'done' || task.status === 'failed'),
    activeId: active.length === 1 ? active[0]!.id : null,
  }
}

/**
 * 不带方框写出来的计划。
 *
 * 只在宣告了 plan 或任务清单的标题之下才认，这样一份普通的分条回答不会被误当成计划。
 */
function looseList(lines: readonly string[]): string[] | null {
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s|\*\*.+\*\*\s*$/u.test(line))
  if (headingIndex === -1) return null
  const headings = lines.slice(0, headingIndex + 1).join(' ')
  if (!/计划|任务|步骤|清单|plan|task|step|checklist/iu.test(headings)) return null
  const items: string[] = []
  for (const line of lines.slice(headingIndex + 1)) {
    const labelled = LABELLED.exec(line)
    if (labelled !== null) {
      const body = (labelled[1] ?? '').trim()
      if (body !== '') items.push(body)
      continue
    }
    // 列表到它之外的第一行就结束，这样计划后面的散文
    // 不会被吞进任务清单里。
    if (line.trim() === '') continue
    if (items.length > 0) break
  }
  return items.length >= 2 ? items : null
}

/**
 * 把 plan 渲染回清单文本。
 *
 * 用来在面板里展示这份列表，也用来在测试里证明 plan 能经受一次往返。勾选是 `x`，
 * 失败是 `!`，进行中的任务是 `>`。
 *
 * @param plan - 要渲染的 plan。
 * @returns markdown 行，每个任务一行。
 */
export function renderPlan(plan: Plan): string {
  return plan.tasks
    .map((task) => `- [${task.status === 'done' ? 'x' : task.status === 'failed' ? '!' : task.status === 'active' ? '>' : ' '}] ${task.text}`)
    .join('\n')
}

/**
 * 每种状态各有多少个任务，用来拼一行进度摘要。
 *
 * @param plan - 要计数的 plan。
 * @returns 按状态分的总数，外加共有多少个任务。
 */
export function planProgress(plan: Plan): { done: number; failed: number; active: number; pending: number; total: number } {
  const count = (status: PlanTaskStatus): number => plan.tasks.filter((task) => task.status === status).length
  return {
    done: count('done'),
    failed: count('failed'),
    active: count('active'),
    pending: count('pending'),
    total: plan.tasks.length,
  }
}
