/**
 * 本地跨模态检查：页面自己的文本，和模型说图片里有什么，对得上吗？
 *
 * 关键就在于模型看不到这次比较，也影响不了它。被问“这是什么？”的 vision 模型，
 * 不管有没有真读过图片都能答得很流利，而它的语言先验压得过微弱的视觉证据；
 * 页面的文本是另一份独立证词，查它一文不花。两边对不上，答案就可疑，
 * 绝不能拿来驱动任何动作。
 *
 * 这项检查抓得住什么、抓不住什么：
 *
 * - 只有一种情况它能*证明*冲突：百分比和页面声明的百分比打架，因为数字自带单位，
 *   要么一致，要么有一个是错的。
 * - 主题上的距离它只能*标记*，证明不了：一段描述压根没提页面对这张图片说的话。
 *   这种情况报 `uncertain` 加一条备注，绝不报成冲突。词的重叠分不清
 *   “描述和页面不一致”和“描述很短、标题却是营销文案”——像
 *   “微缩创意五口之家三孩三胎家庭过积木桥”这种标题，里面大多数词一段诚实的
 *   120 字符描述都不会重复，可“五个人偶站在积木拱桥上”跟它是一致的。把这种情况
 *   叫冲突就是喊狼来了，而一个意见一致时也会响的警报，等真出事的时候已经没人听了。
 * - 一个看着合理、其实错了，但用词恰好和页面一致的答案，它抓不住；
 *   页面完全没描述过的图片，它也说不出什么。这两种都保持 `uncertain`，
 *   调用方必须把它当成“问用户”，绝不是“没问题”。
 *
 * 阈值只是起始值，没校准过：要拿真实的描述/页面对来调，而这里报出来的计数，
 * 正是那次调参要消耗的东西。
 *
 * @module
 */

/** 模型被问之前，页面对这张图片说过的话。 */
export interface CompareContext {
  /**
   * 作者自己写的文本（`alt`、`aria-label`、`title`）。
   *
   * 每个字段都是可选的，因为页面只是偶尔给得出其中某一个：一张既没说明文字也没标题的
   * 图片太常见了，而从 DOM 拼这个对象的调用方，不该为了凑类型去编空字符串。
   */
  alt?: string | undefined
  /** 打印在图片旁边的文本。 */
  near?: string | undefined
  /** 最近的标题：也就是这张图片所在的章节。 */
  heading?: string | undefined
}

/** 页面文本和描述之间的一处对不上。 */
export interface CompareConflict {
  rule: 'percentage' | 'theme'
  detail: string
}

/** 比较结果，以及这个结果有多少依据。 */
export interface CompareResult {
  /** `conflict` 禁止自动执行；`uncertain` 询问用户。 */
  verdict: 'consistent' | 'uncertain' | 'conflict'
  conflicts: CompareConflict[]
  /**
   * 描述几乎没提页面对这张图片说的话时才会设置。
   *
   * 是备注，不是冲突：它记的是主题上的距离，那只能算"可能有问题"的一项证据，
   * 不是有问题的证明。
   */
  note?: string
  /**
   * `none` 表示页面关于这张图片什么都没说，所以什么都没查；`skipped` 表示当前档位
   * 压根不检查。两者都如实报出来，不并进 `consistent`——并进去就等于声称做过一次
   * 根本没跑过的校验。
   */
  basis: 'text' | 'none' | 'skipped'
  /** 页面里的重要 token 有多少出现在描述里。 */
  overlap: number
}

/** 包含度低于这个值，就等于描述几乎没提页面的文本。 */
const MENTIONS_BELOW = 0.2

/** 包含度到这个值以上，读起来就是一致。 */
const CONSISTENT_AT = 0.45

/** 两个百分比的相对差异超过这个值就算互相矛盾。 */
const PERCENT_TOLERANCE = 0.1

/** 太常见、两个方向上都带不了主题信息的词。 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have',
  'image', 'photo', 'picture', 'screenshot', 'chart', 'graph', 'icon', 'logo', 'background',
  '图片', '图像', '照片', '截图', '图标', '背景', '一个', '这个', '那个', '以及', '显示', '上面',
])

/** 拉丁词加 CJK 二元组：便宜、不引依赖，跨语言也够用。 */
function tokensOf(text: string | undefined): Set<string> {
  const tokens = new Set<string>()
  if (text === undefined || text === '') return tokens
  const lowered = text.toLowerCase()
  for (const word of lowered.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    tokens.add(word)
  }
  // CJK 不用空格，单个字太常见，整段又太具体；相邻字对是通常的折中。
  const cjk = lowered.replace(/[^\u3400-\u9fff]+/gu, ' ')
  for (const run of cjk.split(/\s+/)) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!STOP_WORDS.has(bigram)) tokens.add(bigram)
    }
  }
  return tokens
}

/** 文本里的百分比数值，按出现顺序。 */
function percentagesOf(text: string | undefined): number[] {
  const found: number[] = []
  if (text === undefined || text === '') return found
  const pattern = /(\d+(?:\.\d+)?)\s*(?:%|％|percent)/gi
  let match = pattern.exec(text)
  while (match !== null) {
    const value = Number(match[1])
    if (Number.isFinite(value)) found.push(value)
    match = pattern.exec(text)
  }
  return found
}

/**
 * 拿一段描述和页面自己的文本比一比。
 *
 * @param desc - 模型给出的一行描述。
 * @param context - 这张图片的作者文本、附近文本和标题。
 * @param pageText - 页面的可见文本，用来找别处声明的数字。
 * @returns 判定、发现的冲突，以及产生这些结果的重叠度。
 */
export function compareDescription(
  desc: string,
  context: CompareContext,
  pageText = '',
): CompareResult {
  const conflicts: CompareConflict[] = []
  const description = tokensOf(desc)
  const own = [...tokensOf(context.alt), ...tokensOf(context.near), ...tokensOf(context.heading)]

  // 描述这一侧：这个答案到底提到了多少页面对这张图片说的话。取的是这个方向的包含度，
  // 不是 Jaccard：啰嗦但覆盖了说明文字的答案没问题，讲别的东西的答案则一点都不共享。
  let overlap = 0
  let note: string | undefined
  if (own.length > 0) {
    const hits = own.filter((token) => description.has(token)).length
    overlap = hits / own.length
    if (overlap < MENTIONS_BELOW) {
      const missing = own.filter((token) => !description.has(token)).slice(0, 4).join(', ')
      note = `the description does not mention what the page says about this image (${missing})`
    }
  }

  // 页面声明的百分比是可以比的量，因为它自带单位：答案里的百分比要么跟它一致，
  // 要么有一个是错的。
  //
  // 先查图片自己的文本，整个页面只作兜底。本来设计的是全页扫一遍，但一个满是百分比的
  // 页面（仪表盘、价目表）几乎跟任何答案都会偶然撞上，而这里报一次冲突就要花用户一次
  // 确认。先读说明文字，信号才能一直挂在作者系在这张图片上的那个数字上。
  const described = percentagesOf(desc)
  const ownPercentages = percentagesOf([context.alt, context.near, context.heading]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' '))
  const stated = ownPercentages.length > 0 ? ownPercentages : percentagesOf(pageText)
  if (described.length > 0 && stated.length > 0) {
    for (const value of described) {
      const nearest = stated.reduce(
        (best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
        stated[0] ?? value,
      )
      const scale = Math.max(Math.abs(value), Math.abs(nearest), 1)
      if (Math.abs(nearest - value) / scale > PERCENT_TOLERANCE) {
        conflicts.push({
          rule: 'percentage',
          detail: `description says ${String(value)}% but the page states ${String(nearest)}%`,
        })
      }
    }
  }

  // 只有白纸黑字的数字才证明得了分歧；别的都只是备注。
  if (conflicts.length > 0) return { verdict: 'conflict', conflicts, basis: 'text', overlap }
  if (own.length === 0) {
    // DOM 里没有任何东西描述这张图片，那也就没什么可查的。
    // 报 `consistent` 等于声称做过一次根本没发生过的校验。
    return { verdict: 'uncertain', conflicts: [], basis: 'none', overlap: 0 }
  }
  return {
    verdict: overlap >= CONSISTENT_AT ? 'consistent' : 'uncertain',
    conflicts: [],
    basis: 'text',
    overlap,
    ...note === undefined ? {} : { note },
  }
}
