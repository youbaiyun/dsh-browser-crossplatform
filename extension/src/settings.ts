/**
 * 扩展设置，以及 background service 和控制条之间的 port 契约。
 *
 * 两端都只认这一个模块，所以字段不会出现一边是 worker 存进去的、另一边是控制条渲染出来的这种
 * 漂移。这里刻意不依赖任何东西：service worker、弹窗、独立的控制页面都会导入它。
 *
 * @module
 */

import type { BridgeState } from './background/bridge.ts'
import { isTabSwitchMode, type TabAffinityState, type TabAffinityDecision, type TabSwitchMode } from './background/tab-affinity.ts'
import type { ApprovalDecision, ApprovalRequest } from './security/approval.ts'
import { normalizeTrustedOrigin } from './security/trusted-origins.ts'

/** 所有控制条视图共用的 port 名。 */
export const CONTROL_PORT_NAME = 'dsh-control'

/** 持久化在 `chrome.storage.local` 里的用户设置。 */
/**
 * 模型问起某张图片时，图像识别做到哪一步。
 *
 * 这些档位换的是成本和“这个答案有多可信”，跟执行权限无关：要不要照着一段描述去做，由审批规则
 * 决定，那些规则不会因为这里变了而变。
 *
 * - `off` —— 不识别。什么都不抓，也没有任何图片离开本机，所以全新安装默认停在这一档，而不是停在
 *   最便宜的那一档。
 * - `low` —— 关掉思考来描述这张图，也不拿它去和任何东西校验。想知道“这张图里有什么”时，这是
 *   最便宜的有用答案。
 * - `standard` —— 描述之外，再和页面自身的文本做一次本地跨模态校验，于是与页面矛盾的那段描述
 *   会被标出来，而不是被当真。
 * - `enhanced` —— 校验之外，提示词还会追问这张图和周围页面的关系。每张图多花一些 token，适合
 *   图片本身就是内容、而不是插图的页面。
 */
export type VisionTier = 'off' | 'low' | 'standard' | 'enhanced'

export interface Settings {
  /**
   * bridge 的 WebSocket 地址；留空表示“自动发现本机的 dsh”。
   *
   * 面板里不暴露：支持的路径上，扩展自己就能找到 bridge。之所以还留在存储里，是为了让随安装
   * 提供的排障 skill 在自动发现覆盖不到时能设上它；{@link token} 是同一类逃生口。
   */
  bridgeUrl: string
  /** Bearer token；Chrome 连回环地址不需要，Firefox 则总是需要。 */
  token: string
  /**
   * 读页面与动手之前问不问用户。
   *
   * 只有两档：`'ask'` 两者都问，`'auto'` 两者都不问。原先还有第三个 `'off'`
   * （号称页面内容不离开浏览器），但它只是**看起来**能拦：分发模式在
   * `unrestrictedBrowserAccess`（出厂即开）下被强制成 `'auto'`，所以默认安装里
   * 它一档都不生效。一个不生效的隐私开关比没有更糟——它给的是假的保证，
   * 所以这个值连同它那条阻断分支一起删掉了；已经存了 `'off'` 的用户会落到 `'ask'`。
   */
  sharePageContent: 'ask' | 'auto'
  /** 图像识别做到哪一步；见 {@link VisionTier}。 */
  visionTier: VisionTier
  /**
   * 扩展自己直连的 chat-completions 端点；'' 表示只用桌面端。
   *
   * 桌面端中继能答就用它，因为它握着凭据，也不用改 manifest。这个设置留给它答不了的情况：桌面端
   * 没配视觉模型的部署，或者用户就是想让调用从自己浏览器直接发出去。
   *
   * manifest 的 `connect-src` 为此放开了 `https:` 和 `http:`，所以用户填哪个端点都连得上。
   */
  visionEndpoint: string
  /**
   * 这些调用要用的 bearer token。
   *
   * 它和其他设置一样存在存储里，也就意味着扩展自己的页面也读得到。信任级别跟 bridge token 一样，
   * 所以这条路径要逐次安装手动选择加入，而不是默认打开。
   */
  visionApiKey: string
  /**
   * 扩展自己的调用用哪个模型 id；'' 表示用共享的默认值。
   *
   * 端点可配，所以它也得可配：把浏览器指到另一个提供方却沿用同一个 id，发出去的名字对方根本
   * 没听说过。留空时会解析成 API 认的、能读图片的那个 id，所以从来不碰这个字段的安装也不会出错。
   */
  visionModel: string
  /** 所有浏览器操作都不弹审批提示。 */
  unrestrictedBrowserAccess: boolean
  /** 这些 origin 上的改状态操作不用再确认就能跑。 */
  trustedActionOrigins: string[]
  /**
   * 没有面板可显示审批时，改成发一条系统通知。
   *
   * 面板里不暴露：自动打开开着的时候，审批出现之前面板基本已经在了，所以它只覆盖用户把自动打开
   * 关掉的那种情况。想关掉它的人仍然可以改存储。
   */
  approvalNotifications: boolean
  /**
   * 模型一动浏览器，就把面板拉到前台。
   *
   * 重点是能看着活儿怎么干的——它在翻什么、在下载什么——而不是只看一个结果，不知道它是哪来的。
   * 只有浏览器工具即将运行时才会触发，聊天消息绝不算，所以普通对话抢不走屏幕。
   */
  autoOpenPanel: boolean
  /**
   * 用户手动切 tab 后，工具的目标 tab 怎么办。
   *
   * `ask` 弹交接提示，`follow` 跟着用户走，`keep` 留在绑定的 tab 上。做成设置而不是每次切换都问
   * 一遍，因为已经回答过的问题只会是噪音；用“别再问了”作答，答案就落在这里。
   */
  tabSwitch: TabSwitchMode
  /**
   * 面板的消息发到桌面端的哪个对话。
   *
   * `fresh` 和 `last` 的差别只有一处：这次要不要沿用上一段对话。`last` 复用记住的那段，
   * `fresh` 先把它忘掉、下一条消息开一段新的。两档都把这个 id 存在扩展存储里，不只放在内存里，
   * 所以 background worker 被回收也扛得住——Chrome 在侧边面板闲置之后就会回收，过去正是这一点
   * 把用户的浏览历史打碎成每个超时一个会话。
   *
   * `workspace` —— 「全部工作区」—— 镜像桌面端每一个工作区里的对话，而不是只镜像一个，所以
   * 桌面侧发出的指令不用事先挑中就会出现在这里。提示照样发往面板自己的对话：镜像关心的是看着
   * 桌面端在驱动什么，写进某个被镜像的对话是另一项功能。
   *
   * 目标只挑不猜：桌面端没有暴露“我正在看哪个会话”这种信号，从最近活动去推断只会把消息悄悄发进
   * 错误的对话。
   */
  sessionScope: SessionScope
  /**
   * transcript 和输入框的舒适宽度上限，单位是像素。
   *
   * 侧边面板多宽归浏览器管：用户拖它的边，浏览器记住那个宽度——没有任何扩展 API 读得到、设得了
   * 或者锁得住它。所以这不是面板尺寸。它只是不让特别宽的面板拉出长得离谱的行，比它窄的面板则
   * 照用不误。
   */
  readWidth: number
}

export const SETTINGS_DEFAULTS: Settings = {
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  visionTier: 'off',
  visionEndpoint: '',
  visionModel: '',
  visionApiKey: '',
  // 每个页面都读，不问了直接动手。这三个是随安装给的姿态，不是随手填的值，所以理由就放在它们
  // 旁边：
  //
  // - `unrestrictedBrowserAccess: true` 意味着全新安装不会为浏览器工具弹任何审批——click、
  //   type、关 tab 都直接走。它还会在解析分发模式的地方把 `sharePageContent` 强行改成 `'auto'`，
  //   不管那个设置当前是什么，也就是说它会盖掉选了“读页面前先问”的用户。控制条会把这个取舍
  //   直说，用户也能关掉它；默认值只决定不知情的用户被推向哪一边，这里推的是“模型可以动手”，
  //   而不是“在你答话之前什么都不会发生”。
  // - `sessionScope: 'workspace'` 镜像桌面端的**每一个**工作区，所以在那边发出的指令不用先被
  //   选中就会出现在面板里。bridge 没给出任何工作区时，它退回面板自己的对话。
  // - `tabSwitch: 'follow'` 让模型看见用户刚打开的新网页，而不是打断式地问一遍。这一档是
  //   出厂值，面板上也这么写（「默认跟随，不再询问」）。
  unrestrictedBrowserAccess: true,
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoOpenPanel: true,
  tabSwitch: 'follow',
  sessionScope: 'workspace',
  readWidth: 640,
}

/** 持久化 {@link Settings} 对象所用的存储键。 */
export const SETTINGS_STORAGE_KEY = 'dshSettings'

/**
 * 给从扩展浏览器面板进入会话的文本打的标记。
 *
 * 模型通过 `browser_snapshot` 读到的是不可信的页面文本，光靠它自己分不清哪句是真用户指令、哪句
 * 是网页里植入的话。给每条面板提示标上来源，它就有一条能机械套用的规则：带这个标记的文本算用户，
 * 其余一切只是像指令的东西都算页面内容。
 *
 * 放在这里、放在设置旁边，是因为发它的 worker 和断言它的测试都要用——而本模块没有任何运行时
 * 依赖，导入它不会把 service worker 一起拖进来。
 */
export const BROWSER_PANEL_MARKER = '[用户·浏览器面板]'

/** 一次执行过的浏览器操作，留着给控制条的短历史用。 */
export interface ActivityEntry {
  /** 本地稳定 id；调用活着的时候它也是 bridge 的 tool-call id。 */
  id: string
  /** 谁发起的：走 bridge 的模型，还是用户敲的命令。 */
  kind: 'tool' | 'command'
  /** 工具名，比如 `browser_click`。 */
  name: string
  /** 面向用户的摘要，来自审批提示，或者就是工具名。 */
  summary: string
  /** 这次操作针对的 origin，能推出来的时候才有。 */
  origin: string | null
  state: 'running' | 'done' | 'failed' | 'denied' | 'cancelled' | 'pending'
  at: number
}

/** 当前轮次的一段助手文本 delta，或者一次整体替换。 */
export interface AssistantStreamEvent {
  sessionId: string
  /** 'snapshot' 替换全部内容；'delta' 是单个流式帧。 */
  kind: 'snapshot' | 'delta'
  /** 交给控制页面自己解释的原始 payload（snapshotId/frame 或 frame）。 */
  payload: unknown
}

/** 执行时间线上的一行：一次用户请求、一个模型步骤，或一次工具运行。 */
export interface TimelineEntry {
  id: string
  /** 'request' = 用户敲的文本；'assistant' = 模型输出；'step' = 一次工具/命令运行。 */
  kind: 'request' | 'assistant' | 'step'
  /** 显示用文本：键入的请求、助手文本，或步骤摘要。 */
  text: string
  /** 只在 kind 为 'step' 时有。 */
  tool?: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'denied' | 'cancelled'
  at: number
  /** 有 tool-call id 时，用它把步骤对上号。 */
  callId?: string
  /**
   * 这一行来自哪个对话。
   *
   * 其他模式下面板一次只跟一个对话，所以那儿它是多余的——但「工作区内」会同时镜像多个，缺了它，
   * 不同对话的行会混成一列没法看的东西，清空一个对话还会顺手清掉别人的。
   */
  sessionId?: string
}

/** 控制条从一条消息里渲染出的全部内容。 */
export interface ControlState {
  /** 持久化的设置是否还允许连接。 */
  enabled: boolean
  bridge: BridgeState
  caps: { snapshotMaxChars: number; maxInteractiveItems: number } | null
  affinity: TabAffinityState
  /** 还在等这个用户拍板的审批，最旧的排前面。 */
  approvals: ApprovalRequest[]
  settings: Settings
  /** 只在当前 bridge 会话里可信的 origin；重连就没了。 */
  sessionTrustedOrigins: string[]
  /** 最近的浏览器操作，最新的在前。 */
  activity: ActivityEntry[]
  /** 这个 worker 驱动的那唯一一个 dsh 会话，以及它的轮次是否在跑。 */
  session: { id: string | null; turn: 'idle' | 'running'; pendingPrompt: boolean }
  /** 到目前的运行过程，最旧的行在前；有上限，存在 worker 里而不是页面里。 */
  timeline: TimelineEntry[]
  /**
   * 桌面应用允许了什么，按握手时的约定。握手之前为 null。
   *
   * 发给面板，是为了让它自己的开关跟权威设置保持一致，而不是悄悄对不上：一个看着是开着、应用里
   * 其实关着的开关，比没有开关更糟。
   */
  policy: { openPagesForUser: boolean } | null
  /**
   * bridge 把这个浏览器的槽位让给别的浏览器时为 true。
   *
   * 这跟普通断开不一样：扩展到这儿会主动停止重试，所以面板还显示“正在重连”就是在撒谎，而只显示
   * 一句笼统的失败，又把唯一有用的事实藏了起来——连接被另一个 profile 拿走了。
   */
  replaced: boolean
  /**
   * bridge 明确拒绝了这次握手时的关闭码与理由；没有拒绝过则为 null。
   *
   * 只有这一类失败是用户自己修得好的（装错了构建、扩展 id 不在白名单、令牌不对），所以
   * 必须说出来。否则它和"桌面端没开"在面板上是同一个「未连接」，用户没有任何线索。
   */
  bridgeRejection?: { code: number; reason: string } | null
  /**
   * 面板想跟某个对话却跟失败时，失败的原因。
   *
   * 摆出来而不是写进日志，是因为最常见的原因是桌面应用还在跑一个更老的 bridge——不认
   * `session.follow` 的那种——唯一的修法就是把它重启。没有它，面板就只是一片空白、什么都不说，
   * 跟真的没内容可显示完全分不出来。
   */
  followError: string | null
}

/** 控制条 → background。 */
export type ControlRequest =
  | { type: 'state.request' }
  | { type: 'settings.update'; id: string; settings: Partial<Settings> }
  | { type: 'approval.respond'; id: string; decision: ApprovalDecision }
  | { type: 'affinity.respond'; revision: number; decision: TabAffinityDecision }
  | { type: 'affinity.rebind'; id: string }
  | { type: 'session-trust.clear' }
  /**
   * 槽位被别的浏览器拿走之后，把 bridge 槽位要回来。
   *
   * 这是从被顶替状态里出来的唯一办法，所以必须由用户来点：扩展不会自己去抢槽位，否则两个开着的
   * 浏览器会永远互相驱逐。
   */
  | { type: 'bridge.reclaim' }
  /** 现在就建 worker 那唯一一个 dsh 会话，别等到第一次提示。 */
  | { type: 'session.create'; id?: string }
  /** 把用户敲的指令转给桌面 dsh 模型。 */
  | { type: 'session.prompt'; id: string; text: string }
  /** 停掉 worker 会话里正在跑的轮次。 */
  | { type: 'session.cancel'; id: string }
  /** 拉取桌面端最近的对话，给面板的会话选择器用。 */
  | { type: 'session.list'; id: string }
  /**
   * 选面板的消息发往哪个对话。
   *
   * `follow: true` 还会开始把那个对话的事件流给面板，面板能显示一个由*桌面应用*驱动的对话全靠
   * 它：没有来自面板的提示，就没有东西会去打开跟随器，面板对着一个正忙的 Session 只会渲染出
   * 空白 transcript。
   */
  | { type: 'session.select'; id: string; scope: SessionScope; sessionId: string | null; follow?: boolean }
  /** 跑一条用户敲的 `browser_*` 命令，不经过桌面应用。 */
  | { type: 'command.run'; id: string; name: string; args: Record<string, unknown> }
  /**
   * 跑一条 `@open` 指令：当着用户的面打开一个 URL。
   *
   * 这件事扩展自己做完——打开、置前、绑定、显示面板——所以“我能看到它”不取决于模型肯不肯配合。
   */
  | { type: 'open.run'; id: string; url: string; pace: 'fast' | 'normal' | 'slow'; pin: boolean }

/**
 * 面板自己的消息发往哪个对话。
 *
 * - `fresh` —— 「工作区内新建对话」：下一条消息在浏览器工作区里开一段新的。
 * - `last` —— 「工作区内上次浏览器对话」：接着上一段用过的对话。
 * - `workspace` —— 「全部工作区」：镜像桌面端**所有**工作区里的对话。提示还是发往面板自己的
 *   对话，因为镜像关心的是看着桌面端在驱动哪些对话。
 *
 * 原先还有一个 `pinned`（用户在设置里点名一段对话）。它和 `last` 是两套指向同一件事的机制，
 * 而「上次那段」本来就已经被记住了，于是那个手选的 id 成了第二处真相来源；两者合并成 `last`。
 * 存过 `pinned` 的用户落到 `last` —— 他们当初选的是"接着一段已有对话"，这是最接近的一档。
 */
export type SessionScope = 'fresh' | 'last' | 'workspace'

/**
 * 把一个不可信的设置字段收窄成对话范围。
 *
 * 用一道守卫，而不是在每个使用处写一串比较：这样回退值指的是默认值，不是又抄一遍字面量，于是改
 * 随安装给的默认值时不会漏掉归一化逻辑——默认值搬到 `workspace` 那次就是这样。
 *
 * @param value - 存储里的原始值。
 * @returns 它是不是这个构建认识的范围。
 */
export function isSessionScope(value: unknown): value is SessionScope {
  return value === 'fresh' || value === 'last' || value === 'workspace'
}

/**
 * 把落盘的旧 `sessionScope` 折算成现在的取值。
 *
 * 只为一件事存在：`pinned` 那一档已经并入 `last`。归一化里不能就这么让它掉到默认值
 * `workspace` —— 那会把"接着自己那段对话"的用户改到"镜像全部工作区"，不是他选的东西。
 *
 * @param value - 存储里的原始值。
 * @returns 现在的范围；不认识的值交给调用方回落到默认值。
 */
export function migrateSessionScope(value: unknown): SessionScope | undefined {
  if (isSessionScope(value)) return value
  return value === 'pinned' ? 'last' : undefined
}

/** 一个桌面端对话，bridge 披露多少算多少。 */
export interface SessionSummary {
  sessionId: string
  /**
   * 显示名；对话没有标题时，桌面端会给空串。
   *
   * 它收到时是嵌在 `projections.values.title` 里的，不在顶层——再为这个加读取方之前，这点值得
   * 先知道。
   */
  title: string
  /**
   * 用户在这个对话里敲的第一句话，裁成一行。
   *
   * 选择器需要它，因为标题会撞：桌面端按主题命名对话，于是两个聊同一个视频的对话会拿到几乎一样
   * 的标题（"介绍哔哩哔哩罗肖尼视频" 对 "哔哩哔哩罗肖尼视频介绍"），没标题的对话更是一条都没有。
   * 开场那句提示才说明这个对话到底是什么。桌面端什么都没披露时为空。
   */
  preview: string
  /** 最后一次更新的 epoch 毫秒数，给选择器排序用。 */
  updatedAt: number
  running: boolean
}


/** background → 控制条。 */
export type ControlMessage =
  | { type: 'state'; state: ControlState }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'approval.request'; request: ApprovalRequest }
  | { type: 'settings.result'; id: string; ok: true }
  | { type: 'settings.result'; id: string; ok: false; error: string }
  | { type: 'affinity.rebind.result'; id: string; ok: true }
  | { type: 'affinity.rebind.result'; id: string; ok: false; error: string }
  /** 当前轮次的一段助手文本 delta，或者一次整体替换。 */
  | { type: 'session.stream'; event: AssistantStreamEvent; sessionLabel?: string | null }
  /** 一条原始的 `session/event`，交给页面自己渲染：工具、消息、轮次边界。 */
  | { type: 'session.event'; sessionId: string; event: unknown; sessionLabel?: string | null }
  /** 对一次 session/command 请求的答复；每个被接受的请求正好一个结果。 */
  | { type: 'session.result'; id: string; ok: true; sessionId?: string; result?: unknown }
  | { type: 'session.result'; id: string; ok: false; error: string }
  /** 桌面端最近的对话，最新的在前。 */
  | { type: 'session.list'; id: string; ok: true; sessions: SessionSummary[] }
  | { type: 'session.list'; id: string; ok: false; error: string }

/** 把不可信的设置候选值归一化成一个完整可用的对象。 */
export function normalizeSettings(candidate: Partial<Settings> | undefined): Settings {
  const source = candidate ?? {}
  const trusted = Array.isArray(source.trustedActionOrigins)
    ? [...new Set(source.trustedActionOrigins
        .map((entry) => (typeof entry === 'string' ? normalizeTrustedOrigin(entry) : undefined))
        .filter((entry): entry is string => entry !== undefined))].sort()
    : SETTINGS_DEFAULTS.trustedActionOrigins
  // 旧的 `'off'` 落到 `'ask'`，而不是默认的 `'auto'`：它当年选的是"更严格的一档"，
  // 降级成"什么都不问"会把一个隐私意图反着实现。
  const sharePageContent = source.sharePageContent === 'auto'
    ? 'auto'
    : source.sharePageContent === 'ask' || source.sharePageContent === 'off' ? 'ask' : SETTINGS_DEFAULTS.sharePageContent
  const visionTier = source.visionTier === 'low' || source.visionTier === 'standard' || source.visionTier === 'enhanced'
    ? source.visionTier
    : SETTINGS_DEFAULTS.visionTier
  return {
    bridgeUrl: typeof source.bridgeUrl === 'string' ? source.bridgeUrl.trim() : SETTINGS_DEFAULTS.bridgeUrl,
    token: typeof source.token === 'string' ? source.token.trim() : SETTINGS_DEFAULTS.token,
    sharePageContent,
    visionTier,
    visionEndpoint: typeof source.visionEndpoint === 'string' ? source.visionEndpoint.trim() : SETTINGS_DEFAULTS.visionEndpoint,
    visionModel: typeof source.visionModel === 'string' ? source.visionModel.trim() : SETTINGS_DEFAULTS.visionModel,
    visionApiKey: typeof source.visionApiKey === 'string' ? source.visionApiKey.trim() : SETTINGS_DEFAULTS.visionApiKey,
    // 只要不是 boolean 就退回随安装给的默认值，而不是退回 `false`。旧写法
    // （`source.x === true`）下，存过的、坏掉的或者干脆没有的值一律被读成“关”，这个字段就被
    // 悄悄钉死在默认值的反面——默认值改成什么都是白改。
    //
    // 兼容上的后果是刻意的，也说清楚：这个字段出现之前写下的设置记录里没有它，所以升级上来的用户
    // 会继承随安装给的默认值。真正选过 `false` 的用户会保住它，因为 `false` 是 boolean，会被
    // 保留。只有清掉站点数据才会把人送回默认值。
    unrestrictedBrowserAccess: typeof source.unrestrictedBrowserAccess === 'boolean'
      ? source.unrestrictedBrowserAccess
      : SETTINGS_DEFAULTS.unrestrictedBrowserAccess,
    trustedActionOrigins: trusted,
    approvalNotifications: source.approvalNotifications !== false,
    autoOpenPanel: source.autoOpenPanel !== false,
    tabSwitch: isTabSwitchMode(source.tabSwitch) ? source.tabSwitch : SETTINGS_DEFAULTS.tabSwitch,
    sessionScope: migrateSessionScope(source.sessionScope) ?? SETTINGS_DEFAULTS.sessionScope,
    readWidth: clampReadWidth(source.readWidth),
  }
}

/** 把阅读宽度上限夹在还算行长、不算布局的区间里。 */
export function clampReadWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SETTINGS_DEFAULTS.readWidth
  return Math.min(1200, Math.max(360, Math.round(value)))
}
