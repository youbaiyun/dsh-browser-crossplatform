/**
 * dsh 桌面应用的浏览器执行 worker。
 *
 * 对话界面仍然是桌面 GUI：这个 worker 只维持一条常开的、已认证的桥接 socket，
 * 让模型的 `browser_*` 工具调用落到这里，派发进用户自己控制的标签页，
 * 再用纯文本把结果答回去。整页的控制 UI 也在这里，
 * 它在同一条桥接上多给两项能力：在控制页里输入的指令会转给桌面模型
 * （`session.prompt`），流式回复、轮次边界和工具进度原样回传；
 * 在控制页里输入的 `browser_*` 命令，则走完全相同的派发路径在本地执行，
 * 从不经过桌面应用。
 * worker 自己不保存对话：一个会话、一条有上限的时间线、没有完整记录，
 * 也不持久化任何东西。
 *
 * 生命周期：设置一加载就开始连接 —— 没有开关要打开，
 * 装上扩展本身就是那个选择 —— 外加一个半分钟的 `alarms` 心跳，
 * 它一边重新武装重连循环，一边把这个 MV3 worker 唤醒。控制页是完整的标签页：
 * 每个视图状态都推一条 `state` 消息，
 * 每个决定也可以直接从系统通知里做出，
 * 所以页面关掉了也绝不会卡住待处理的审批。
 *
 * @module
 */

import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  VISION_MODEL,
  type BridgeCaps,
  type ServerFrame,
} from '@dsh-browser/protocol'
import { BridgeClient } from './bridge.ts'
import { ImageCache, type CacheSnapshot } from './image-cache.ts'
import { chooseImageSource } from './image-fetch.ts'
import { VisionCoordinator, describeOutcomeText, type VisionSink } from './vision.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import { activitySummary } from './activity.ts'
import { createRpc, type RpcFacade } from './rpc.ts'
import { ControlSession, assistantStreamEvent, sessionEventMessage } from './session.ts'
import {
  BROWSER_TOOL_NAMES,
  dispatchOpenTab,
  dispatchToolCall,
  isTabManagementTool,
  parseHttpUrl,
  requestImageTarget,
  resetTabSnapshot,
  type ContentBudget,
  type TabManagementContext,
  type ToolAnswer,
  type ToolCall,
} from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { actionCoveredByTrustedOrigins } from '../security/trusted-origins.ts'
import { ApprovalCoordinator, APPROVAL_TIMEOUT_MS, type ApprovalRequestResult } from './approval-coordinator.ts'
import {
  TabAffinityController,
  isTabAffinityDecision,
  type AffinityTab,
} from './tab-affinity.ts'
import { bindOpenedTabAffinity } from './open-tab-binding.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { getUiLocale } from '../i18n.ts'
import {
  BROWSER_PANEL_MARKER,
  CONTROL_PORT_NAME,
  SETTINGS_DEFAULTS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  type ActivityEntry,
  type ControlMessage,
  type ControlState,
  type SessionSummary,
  type Settings,
} from '../settings.ts'
import type { SessionScope } from '../settings.ts'
import type { BridgePolicy } from '@dsh-browser/protocol'

const BRIDGE_KEEPALIVE_ALARM = 'dsh-bridge-keepalive'
const ACTIVITY_LIMIT = 8
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000
const LEGACY_RECENT_SESSION_STORAGE_KEY = 'dshRecentSessions'
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/**
 * 桌面 dsh 可能监听的本地端口：3080 是 CLI 的默认值，
 * 桌面应用则把自己的 loopback Web 端口写在设置里
 * （43189 是有文档记录的选择，19387 是实际环境里见到的值）。
 * 用户显式指定了 `bridgeUrl` 时，整份列表都会被跳过。
 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189, 19387]

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null

/**
 * 桌面应用允许做什么，由桥接在 `hello.ok` 里告知。
 *
 * 握手完成之前这里是 null，而 null 一律当成"不允许"：
 * 只有应用明确声明过，这项能力才启用。
 * 这个方向不能反 —— 要是字段缺失被当成"允许"，
 * 一次握手出错就会放出用户从没授予的权限。
 */
let bridgePolicy: BridgePolicy | null = null

/** 桌面应用是否已允许代替用户打开页面。 */
function pagesMayBeOpened(): boolean {
  return bridgePolicy?.openPagesForUser === true
}
/** 设置写入队列的队尾；每次写入都挂到它后面。 */
let settingsWrites = Promise.resolve()
let bridge: BridgeClient | null = null
let bridgeStartRevision = 0

const IMAGE_CACHE_STORAGE_KEY = 'dshImageCache'

/**
 * 记住的描述在多长时间内还值得恢复。
 *
 * 描述属于图像本身，而不属于当初请求它的那个视图，
 * 所以它本该比一个页面活得久 —— 但它毕竟是针对某个 URL 的判断，
 * 而那个 URL 随时可能换内容。
 * 一天够覆盖"午饭后回到这个标签页"这种情况，
 * 也不会把上周的答案当成对同一地址今天这些字节的认识端出来。
 */
const IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** 真正写进磁盘的东西：一份快照，外加拍下它的时间。 */
interface StoredImageCache {
  savedAt: number
  cache: CacheSnapshot
}

/**
 * 把缓存持久化出去，因为 service worker 不是保存状态的地方。
 *
 * Chrome 可能在两次工具调用之间就把这个 worker 停掉，浏览器一重启更是必然终结它。
 * 缓存是唯一能切实缩短一次识别的杠杆 —— 同一张图问两次是 1.02s 然后 0.01s ——
 * 只把它放在模块作用域里，就等于把它绑死在 worker 的寿命上，
 * 而 worker 能活多久没有任何保证。
 *
 * 用 `storage.local` 而不是 `storage.session`：session 存储会在扩展重新加载时清空，
 * 而开发期间每次重建都会重新加载，
 * 于是唯一管用的那个杠杆偏偏在要量它的时候没了。
 * 上面那个时间戳，就是为了让这个能挺过重启的存储
 * 不至于把"还记得多少"说得比实际多。
 */
function persistImageCache(cache: ImageCache): void {
  const payload: StoredImageCache = { savedAt: Date.now(), cache: cache.snapshot() }
  void chrome.storage.local.set({ [IMAGE_CACHE_STORAGE_KEY]: payload }).catch(() => {})
}

/**
 * 把磁盘上的描述恢复回来，过期或结构损坏的存储直接丢掉。
 *
 * 没有东西跟它抢时间：识别要等桥接握手，而握手比一次存储读取慢，
 * 所以已经付过费的描述，在下一张图片可能被问到之前就已经就位了。
 */
async function restoreImageCache(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(IMAGE_CACHE_STORAGE_KEY)
    const payload = stored[IMAGE_CACHE_STORAGE_KEY] as Partial<StoredImageCache> | undefined
    if (payload === undefined || typeof payload.savedAt !== 'number') return
    if (Date.now() - payload.savedAt > IMAGE_CACHE_TTL_MS) {
      await chrome.storage.local.remove(IMAGE_CACHE_STORAGE_KEY)
      return
    }
    imageCache.restore(payload.cache)
  } catch {
    // 读不出来的缓存就是空缓存，绝不会变成启动失败。
  }
}

/**
 * 这个 worker 的图像描述能力：一个缓存，两种传输方式。
 *
 * 首次使用时才构建，因为它发送要靠桥接客户端，而客户端要等组装过程稍后才创建。
 * 缓存比它活得久：描述属于图像，不属于连接，
 * 所以丢掉 socket 绝不能变成同一张图付两次费。
 */
const imageCache = new ImageCache(200, 2, persistImageCache)
let visionCoordinator: VisionCoordinator | null = null

/**
 * 页面文本，最近一次快照或 delta 渲染出来是什么样就是什么样。
 *
 * 供跨模态校验做页面级回退：答案里给出的百分比，可以和页面任何地方写出的百分比比，
 * 而不是只能和图片自己的 caption 比。
 */
let lastPageText = ''

function vision(): VisionCoordinator {
  visionCoordinator ??= new VisionCoordinator({
    cache: imageCache,
    send: (frame) => bridge?.send(frame) ?? false,
    // 桌面端在 `hello.ok` 里声明它愿不愿意替这个扩展识别图片。它还没声明之前，
    // 在这里排队只会往缓存里塞满失败。
    canRelay: () => bridgePolicy?.imageRecognition === true,
    // 桌面端中继能作答就用它——凭据在它手里，也不用改 manifest。它是中继答不了时的兜底。
    // 端点和模型必须成套：把浏览器指向另一个提供方、却留着原来的模型 id，
    // 发出去的就是那个提供方从没听说过的名字。两个默认值都指向已知可用的那一对端点和 id，
    // 所以谁都不用去填。但 key 必须填。没有 key 的直接调用只能吃 401，而把这种情况
    // 算成"已配置"，就等于把"这条路径从来没设过"变成一次针对某个没人写过的 key 的
    // 认证失败——正是中继路径当初不得不治好的一模一样的误导。
    directConfig: () => settings.visionEndpoint === '' || settings.visionApiKey === ''
      ? undefined
      : {
          endpoint: settings.visionEndpoint,
          model: settings.visionModel === '' ? VISION_MODEL : settings.visionModel,
          apiKey: settings.visionApiKey,
        },
    pageText: () => lastPageText,
  })
  return visionCoordinator
}

/** 工具派发器交回给视觉流水线的内容。 */
function visionSink(): VisionSink {
  return {
    states: (identity) => vision().stateFor(identity),
    // 调用方会先把标记剥掉：填好的标记里装着一整段描述，
    // 不剥的话，一段提到了数字的描述就会拿它自己跟自己比。
    sawPageText: (text) => { lastPageText = text },
  }
}
/** 当前存活 bridge 世代的 gateway RPC 门面；与 `bridge` 一起创建和清除。 */
let rpc: RpcFacade | null = null
const controlPorts = new Set<chrome.runtime.Port>()
const affinity = new TabAffinityController()
const focusedWindow = new FocusedWindowTracker()
const activity: ActivityEntry[] = []
/** 控制页面渲染的那唯一的会话视图；保存在这里，绝不存在页面里。 */
const control = new ControlSession({ changed: () => { broadcastState() } })

/**
 * 一次还在进行中的 `browser_*` 调用。
 *
 * `unrestricted` 在帧到达的那一刻就把访问模式定下来，所以后来打开全局开关，
 * 绝不可能追溯地把一次已经在审批规则下跑着的调用提升权限；反过来关掉它，
 * 正好能圈出每一个还依赖这份授权的调用。
 */
interface ActiveToolCall {
  controller: AbortController
  unrestricted: boolean
  settled: Promise<void>
  settle: () => void
}
/** 临时白名单：worker 一重启、或用户清空它，就没了。 */
const sessionTrustedActionOrigins = new Set<string>()
/** 还活着的工具调用，好让取消、撤销或断开连接时能把它们收回来。 */
const activeToolCalls = new Map<string, ActiveToolCall>()
let affinityReady = Promise.resolve()
let settingsReady = Promise.resolve()

// ---- 设置 ----

async function loadSettings(): Promise<void> {
  let stored: Record<string, unknown> = {}
  try {
    stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  } catch {
    // 上下文里没有存储可用，那就靠默认值过完这个 worker 的一生。
  }
  const loaded = normalizeSettings(stored[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined)
  // 旧版本会存一个写死的 localhost URL，现在发现逻辑已经覆盖了这种情况；
  // 留着它只会把扩展永远钉在那一个端口上。
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
  }
  settings = loaded
  // 迁移后的值也走同一条共享队列写回去，
  // 免得某个旧版 localhost 地址在后续一次 patch 之后又被存回来。
  void persistSettings({}, true).catch(() => {})
}

/**
 * 把一个设置 patch 持久化下去。
 *
 * 内存里的快照立即更新，所以紧接着的下一次工具调用、下一次 `state` 推送就已经照着用户
 * 的选择走；排队等待的只有写存储那一步。以前两次快速切换会在这里抢，
 * 较早的那次 `storage.local.set` 可能落在较晚那次后面，悄没声地丢掉一个字段，
 * 于是内存和存储对同一条安全设置各说各话。
 */
async function persistSettings(next: Partial<Settings>, alreadyNormalized = false): Promise<void> {
  const normalized = alreadyNormalized ? settings : normalizeSettings({ ...settings, ...next })
  settings = normalized
  const write = settingsWrites.then(
    () => chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized }),
    () => chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized }),
  )
  settingsWrites = write.catch(() => {})
  await write
}

// ---- 控制条 ----

function postToControl(message: ControlMessage): void {
  for (const port of controlPorts) {
    try {
      port.postMessage(message)
    } catch {
      // 检查之后、发送之前，视图被关掉了。
    }
  }
}

/** 在发起请求的那个 port 上作答；视图已经关了也不算错。 */
function replyToPort(port: chrome.runtime.Port, message: ControlMessage): void {
  try {
    port.postMessage(message)
  } catch {
    // 结果还没送到，视图就被关掉了。
  }
}

/** 从任意抛出值里取出给人看的那部分。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 记下一次浏览器操作。
 *
 * 活动列表就是那条简短的"刚刚发生了什么"；同一条记录还会镜像到它对应的时间线步骤上，
 * 所以一次运行在两处读起来一模一样，而页面可以按 id 把某个步骤和它的 origin 对上。
 */
function recordActivity(entry: Omit<ActivityEntry, 'at'>): void {
  const at = Date.now()
  const record: ActivityEntry = { ...entry, at }
  const index = activity.findIndex((candidate) => candidate.id === entry.id)
  if (index === -1) activity.unshift(record)
  else activity[index] = record
  activity.splice(ACTIVITY_LIMIT)
  control.applyActivity(record)
  postToControl({ type: 'activity', entry: record })
}

function controlState(): ControlState {
  return {
    enabled: true,
    bridge: bridge?.state ?? 'stopped',
    caps: caps === null ? null : { snapshotMaxChars: caps.snapshotMaxChars, maxInteractiveItems: caps.maxInteractiveItems },
    affinity: affinity.snapshot(),
    approvals: approvals.pendingRequests(),
    settings: { ...settings, trustedActionOrigins: [...settings.trustedActionOrigins] },
    sessionTrustedOrigins: [...sessionTrustedActionOrigins].sort(),
    activity: activity.map((entry) => ({ ...entry })),
    session: control.session(),
    timeline: control.timeline(),
    policy: bridgePolicy === null ? null : { openPagesForUser: bridgePolicy.openPagesForUser },
    // 问客户端要，而不是从 `bridge === 'stopped'` 猜：被顶替和正常停止收场在同一个状态，
    // 但只有其中一种，用户还有路可走。
    replaced: bridge?.wasReplaced === true,
    // 被 bridge 拒绝（令牌/扩展 id 不匹配）是用户自己修得好的那一类失败，所以要把原因
    // 送到面板上，而不是让它和"桌面端没开"长成同一个样子。
    bridgeRejection: bridge?.lastRejection ?? null,
    followError: followErrorRef,
  }
}

function syncBadge(): void {
  const count = approvals.pendingRequests().length
  void Promise.resolve(chrome.action.setBadgeText({ text: count === 0 ? '' : String(count) }))
    .then(() => chrome.action.setBadgeBackgroundColor({ color: '#d93025' }))
    .catch(() => {})
}

/** Chrome 侧边面板 API，Firefox 上没有。 */
interface ChromeSidePanel {
  open(options: { windowId?: number; tabId?: number }): Promise<void>
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
}

/** Firefox 侧边栏 API，Chrome 上没有。 */
interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function chromeSidePanel(): ChromeSidePanel | undefined {
  return (chrome as unknown as { sidePanel?: ChromeSidePanel }).sidePanel
}

function firefoxSidebar(): FirefoxSidebarAction | undefined {
  return (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
}

/**
 * 把面板送到用户眼前。
 *
 * Chrome 打开侧边面板，Firefox 打开它自己的侧边栏。两条路都从这里走，而不是从
 * `action.onClicked` 走，因为这个函数还要接通知点击，以及 Firefox 上浏览器自带的
 * 侧边栏按钮。
 *
 * 每次调用都发生在用户手势里（click listener、通知点击、键盘命令各算一次），
 * 这是两个 API 都要求的。
 */
function openControlPanel(windowId?: number): void {
  const panel = chromeSidePanel()
  if (panel !== undefined) {
    void panel.open(windowId === undefined ? {} : { windowId }).catch(() => {
      // 调用到一半窗口关了，或者面板本来就开着。
    })
    return
  }
  const sidebar = firefoxSidebar()
  if (sidebar !== undefined) {
    void Promise.resolve(sidebar.open()).catch(() => {})
  }
}

/**
 * 槽位被别的浏览器抢走之后，把 bridge 槽位抢回来。
 *
 * Close code 4000 表示 bridge 把它唯一的那条连接交给了另一个浏览器 profile，
 * 而重试循环是刻意安静的，免得两个开着的 profile 在循环里互相踢。
 * 代价是这个 profile 会一直断着，直到有东西把槽位抢回来；而连接设置从面板里搬走之后，
 * 用户已经没有手动抢的途径了——所以就在他们主动打开面板的那一刻做这件事。
 * 这个手势同时也说明"他们打算用这个浏览器"。
 */
function reclaimBridgeIfReplaced(): void {
  if (bridge?.wasReplaced !== true) return
  armBridgeKeepalive()
  void startBridge()
}

/**
 * 注册随浏览器而变的那部分 chrome。
 *
 * Chrome 用 `setPanelBehavior` 让工具栏图标直接开侧边面板，点击就留在浏览器自己的实现里。
 * 另外还注册了一个显式的 `onClicked` 打开器：Firefox 会忽略它，因为声明的
 * `sidebar_action` 由浏览器自带的侧边栏按钮打开；Chrome 上则是上面那个设置说了算，
 * 所以这个 listener 只会在两者都没有的目标上跑到。
 */
function registerPanelEntryPoints(): void {
  const panel = chromeSidePanel()
  if (panel !== undefined) {
    void panel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  }
  chrome.action.onClicked.addListener(() => { openControlPanel() })
}

registerPanelEntryPoints()

/**
 * 告诉第一次用的人，扩展跑哪儿去了。
 *
 * 新装的扩展不会自己钉到工具栏上，也没有 API 能钉——Chrome 把那个 API 砍了，
 * 只有从 Web Store 装的才默认钉住。于是从文件安装的用户眼前什么都没多出来，
 * 也猜不到工具栏的拼图菜单里放着它。其他每个入口都默认他们已经过了这一关。
 *
 * 这里发通知而不是直接开面板，是因为打开侧边面板要用户手势，而安装过程中根本不存在手势。
 * 通知正好造一个出来：点通知本身算，点它的按钮也算，两种随后都走既有的路径去开面板。
 */
const ONBOARDING_NOTIFICATION_ID = 'dsh-onboarding'
const ONBOARDING_SEEN_KEY = 'dshOnboardingSeen'

function notifyFirstRun(): void {
  const zh = getUiLocale() === 'zh'
  const menu = zh ? '拼图' : 'puzzle-piece'
  void Promise.resolve(chrome.notifications.create(ONBOARDING_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: zh ? 'dsh 浏览器扩展已安装' : 'dsh Browser Extension is installed',
    message: zh
      ? `它没在工具栏上：点地址栏右边的${menu}图标，把这一项固定，以后就好找了。点这条消息可以直接打开侧边栏。`
      : `It is not on the toolbar yet: open the ${menu} menu beside the address bar and pin it, so you can find it later. Click this message to open the side panel now.`,
    buttons: [{ title: zh ? '打开侧边栏' : 'Open the side panel' }],
    requireInteraction: true,
  })).catch(() => {
    // 通知不可用或者被静音了。这里顺手开一下，纯属尽力而为，也可能因为没有手势被拒；
    // 试一下不亏。
    openControlPanel()
  })
}

/** 首次运行提示只显示一次，更新时绝不显示。 */
async function announceFirstRun(reason: string): Promise<void> {
  if (reason !== 'install') return
  try {
    const seen = await chrome.storage.local.get(ONBOARDING_SEEN_KEY)
    if (seen[ONBOARDING_SEEN_KEY] === true) return
    await chrome.storage.local.set({ [ONBOARDING_SEEN_KEY]: true })
  } catch {
    // 存储不可用：照样显示。多一条提示，总好过一个永远找不到扩展的用户。
  }
  notifyFirstRun()
}

chrome.runtime.onInstalled.addListener((details) => {
  void announceFirstRun(details.reason)
})

/** 上一次自动打开面板的墙上时钟时间，下面算冷却期要用。 */
let lastAutoOpenAt = 0

/**
 * 自动打开一次之后，要压多久不再打开。
 *
 * 模型连着跑十次浏览器调用，绝不能因此跟用户较十次劲：面板打开一次，
 * 之后就留在用户放它的地方。
 */
const AUTO_OPEN_COOLDOWN_MS = 60_000

/**
 * 模型马上要动浏览器，先把面板带到前台。
 *
 * 受 {@link Settings.autoOpenPanel} 约束、有速率限制，而且刻意不 await：
 * 打开面板只是个便利，浏览器要是拒绝（没有聚焦窗口、面板已经开着、策略拦截），
 * 绝不能让它触发的那次工具调用跟着失败。和审批路径不同，这里没有用户手势就跑，
 * 所以失败一律吞掉，不往外抛。
 */
function autoOpenPanel(): void {
  // 用户自己的开关和应用策略都要看：把面板抬起来属于"模型马上要给你看点东西"这件事的
  // 一部分，所以桌面应用关掉那项功能之后，它就不能再生效。
  if (!settings.autoOpenPanel || !pagesMayBeOpened()) return
  const now = Date.now()
  if (now - lastAutoOpenAt < AUTO_OPEN_COOLDOWN_MS) return
  lastAutoOpenAt = now
  void chrome.windows.getLastFocused()
    .then((focused) => { openControlPanel(focused.id) })
    .catch(() => { openControlPanel() })
}

// ---- bridge 的发现与连接 ----

async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}${BRIDGE_CONFIG_PATH}`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) {
        continue
      }
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) {
        return body.wsUrl
      }
    } catch {
      // 这个端口上没有东西在跑 bridge：试下一个。
    }
  }
  return undefined
}

/** 本地 bridge 有响应之前，先别去开一个只会报错的 loopback WebSocket。 */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

/**
 * 交还给 alarm 之前，先把发现过程密集重试几次。
 *
 * 启动要和桌面应用自己的启动赛跑：worker 第一次去看的时候，dsh 可能还在绑定端口，
 * 干等 30 秒是一段看得见的卡顿。几秒内试三次足以覆盖正常启动；
 * 之后交给 keepalive 更慢的节奏，所以一个真不存在的应用不会被反复轮询。
 */
const DISCOVERY_RETRY_MS = [1_000, 3_000, 8_000]
let discoveryRetries = 0
let discoveryTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 取消所有已排队的发现重试。
 *
 * 之所以要暴露出来，是因为挂起的定时器比创建它的代码活得久：这次重试会让模块图一直活着，
 * 所以任何拆掉 worker 的东西——测试 unmount、扩展卸载——都得能把它丢掉。
 * 少了这一步，定时器会对着一个陈旧的模块触发，还拨出一个没人要的 socket。
 */
export function cancelPendingWork(): void {
  clearDiscoveryRetry()
  discoveryRetries = 0
  // 清掉定时器拦不住拨号。还有两条路会在本该终结它们的拆卸之后打开 socket：
  // 一个正在重连的客户端会在下一次退避时再拨一次，而一次已经在进行中的 startBridge
  // 会在 await 结算之后建出一个新客户端。自增 revision 用来放弃那次 start，
  // 停掉客户端用来结束重连循环。这样测试只会看到它自己要的那个 socket，
  // 卸载也才真正等于不再有 socket。
  bridgeStartRevision += 1
  bridge?.stop()
  bridge = null
}

function scheduleDiscoveryRetry(): void {
  if (discoveryRetries >= DISCOVERY_RETRY_MS.length) return
  const delay = DISCOVERY_RETRY_MS[discoveryRetries]
  discoveryRetries += 1
  if (discoveryTimer !== undefined) clearTimeout(discoveryTimer)
  discoveryTimer = setTimeout(() => {
    discoveryTimer = undefined
    void startBridge()
  }, delay)
}

/** 丢掉已排队的启动重试：目标已经找到，或者有更新的 start 顶替了它。 */
function clearDiscoveryRetry(): void {
  if (discoveryTimer === undefined) return
  clearTimeout(discoveryTimer)
  discoveryTimer = undefined
}

/** 按当前设置（重新）启动 bridge；地址为空就去自动发现。 */
async function startBridge(): Promise<void> {
  const revision = ++bridgeStartRevision
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge(() => revision === bridgeStartRevision) ?? ''
  }
  // 发现是异步的：它跑着的时候，设置可能已经变了。
  if (revision !== bridgeStartRevision) { return }
  if (url === '') {
    bridge?.stop()
    bridge = null
    rpc = null
    broadcastState()
    // 此刻没有东西在跑 bridge。干等 keepalive，面板在桌面应用起来之后最多要死 30 秒，
    // 而用户启动 dsh 再去开面板，撞上的正是这个窗口。所以改成退避；
    // 退避全错过了，就交给后面某次 alarm 接手。
    scheduleDiscoveryRetry()
    return
  }
  // 目标找到了，启动时那一串重试也就完成使命了。在这里清掉，顺带挡住某个已排队的重试
  // 在这次之后又拨出第二个 socket。
  discoveryRetries = 0
  clearDiscoveryRetry()
  // 手动输入的地址通常只有主机名；bridge 路径是协议常量，所以这里补上，
  // 而不是让它在根路径上失败。
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
  } catch {
    // URL 无效的话，交给 WebSocket 构造函数去报错。
  }
  if (bridge === null) {
    bridge = new BridgeClient({
      onStateChange: (state) => {
        // 刻意不打 trace：每次状态转换都会走到这里，而一个正在重连的客户端会反复绕这些状态。
        // 每打一次 trace 就要把整个日志读-改-写一遍——热路径上实打实的 I/O，
        // 换来的却是面板早就显示过的事实。trace 留给连接的*决策*（发现、探测、拨号），
        // 诊断要的正是那些。
        if (state !== 'connected') {
          cancelAllToolCalls()
          // gateway 调用活不过承载它的 socket：挂起的 RPC 现在就结算掉，
          // 别让页面干等 30s。
          rpc?.fail(state === 'stopped'
            ? 'The dsh bridge was stopped before the gateway answered.'
            : 'The dsh bridge connection dropped before the gateway answered.')
          // "本次会话内信任这个站点"说的是这个连接的会话，不是这个弹窗能活多久：
          // 用户一移开视线控制条就关了，所以这份授权必须比 port 活得久。
          // 它照样跟着 socket 一起消亡，而控制条随时可以收回。
          if (state === 'stopped') sessionTrustedActionOrigins.clear()
          // "重启 dsh"这类提示说的是产出它的那条连接；连接都结束了，
          // 那个说法就不再已知为真。
          followConnectionChanged()
          // 已经在路上的中继往返，没法由一条没了的 socket 来答。直接给个原因结算掉，
          // 别让它耗到超时。
          visionCoordinator?.relayLost('bridge-closed')
          // 用户再也答不了的审批，不能一直挂着。连接一断控制条就关了，决定也就没处可来；
          // 直接丢掉最诚实，重连时会重新问一次。
          approvals.cancelAll()
          // socket 都没了，什么都镜像不了，那个定时器只会每十秒失败一次。
          // 模式本身记着，重连时会在下面的 `onHelloOk` 里恢复。
          stopWorkspaceRefresh()
        }
        broadcastState()
      },
      onFrame: (frame) => { routeFrame(frame) },
      onHelloOk: (negotiated, negotiatedPolicy) => {
        caps = negotiated
        bridgePolicy = negotiatedPolicy
        // 重连或 worker 重启之后，把「工作区内」恢复起来。模式存在设置里，少了这一步，
        // 重连后面板显示着那个设置、却什么都没镜像——而这个模式存在的意义，
        // 恰恰是消掉这种"悄悄空着"的状态。这里也是读取工作区路径的第一个机会，
        // `workspaceSessions` 要靠它找到正确的分组。
        if (settings.sessionScope === 'workspace') {
          // 先把整个分组取回来，用户正在读的 transcript 才会在重连后回来；
          // 下面的刷新再收窄到真正活跃的内容。
          void startWorkspaceMirror({ onlyActive: false }).then(() => { startWorkspaceRefresh() }, () => {})
        }
        broadcastState()
      },
      // 用户的 Auto connect 开关管的是重连策略，不只是首次连接：没有它，
      // socket 一掉，控制条刚报完 bridge 已停止，马上又会被拨一次。
    }, probeBridge, () => true, rediscoverBridgeUrl)
    rpc = createRpc(bridge)
  }
  bridge.start(url, settings.token)
}

/**
 * 自动发现的 bridge 地址不再回应之后，重新解析一次。
 *
 * 只在没有手动填地址时用：手输的地址是一个决定，悄悄拨去另一个端口就是跟它对着干。
 * 返回 undefined 让重试循环保持原样。
 */
async function rediscoverBridgeUrl(): Promise<string | undefined> {
  if (settings.bridgeUrl !== '') return undefined
  const found = await discoverBridge()
  if (found === undefined || found === '') return undefined
  try {
    const parsed = new URL(found)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    return parsed.toString()
  } catch {
    return undefined
  }
}

function routeFrame(frame: ServerFrame): void {
  // 识别结果按请求 id 关联，归视觉流水线管；它没认领的都落到工具路径上。
  if (vision().handleFrame(frame)) return
  if (frame.t === 'tool.call') routeToolCall(frame)
  else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
  else if (frame.t === 'event') routeBridgeEvent(frame.frame)
}

/** bridge 推来的一条事件，已经过 dsh Host 适配器投影。 */
type BridgeEventFrame = Extract<ServerFrame, { t: 'event' }>['frame']

/**
 * 把 bridge 事件帧转发给控制页面。
 *
 * 只转发这个 worker 驱动的会话：第二个 dsh 窗口可能共用这条 bridge，
 * 它的对话不该画进这个页面。这里不缓存也不重放——页面渲染的是实时流，
 * 而一个在轮次中途打开的页面，是从 worker 的时间线重绘出来的，不是从一份重放的日志。
 */
function routeBridgeEvent(frame: BridgeEventFrame): void {
  // 面板此刻正在显示的每个对话。普通模式下就一个，「工作区内」下是整个被镜像的集合——
  // 所以这里用集合而不是单个 id：其中任何一个来的帧都属于屏幕。
  const active = control.activeSessionIds()
  if (frame.method === 'session/assistant-stream') {
    const event = assistantStreamEvent(frame.payload, active)
    if (event === null) return
    // 应用这条事件时创建的行，归它点名的那一个对话。
    control.attributeTo(event.sessionId)
    control.applyStream(event)
    postToControl({ type: 'session.stream', event, sessionLabel: control.labelFor(event.sessionId) ?? null })
    return
  }
  if (frame.method !== 'session/event') return
  const message = sessionEventMessage(frame.payload, active)
  if (message === null) return
  control.attributeTo(message.sessionId)
  control.applyEvent(message.event)
  postToControl({
    type: 'session.event',
    sessionId: message.sessionId,
    event: message.event,
    sessionLabel: control.labelFor(message.sessionId) ?? null,
  })
}

function currentBudget(): ContentBudget | undefined {
  return caps === null ? undefined : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
}

function broadcastState(): void {
  if (controlPorts.size === 0) return
  postToControl({ type: 'state', state: controlState() })
  syncBadge()
}

// ---- 受控 tab ----

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return { tabId: tab.id, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? '' }
}

function observeActiveSummary(summary: AffinityTab): void {
  if (!affinity.observeActive(summary)) return
  persistTabAffinity()
  broadcastState()
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const [tab] = await chrome.tabs.query(query)
    if (signal?.aborted === true) return undefined
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    const summary = summarizeTab(tab)
    if (summary !== null) observeActiveSummary(summary)
    return tab
  } catch {
    return undefined
  }
}

type StoredAffinity =
  | { controlledTabId: number; keptActiveTabId?: number; pinned?: true }
  | { lost: true }

function storedAffinity(): StoredAffinity | null {
  const state = affinity.snapshot()
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null ? { keptActiveTabId: state.active.tabId } : {}),
      ...(state.pinned ? { pinned: true as const } : {}),
    }
  }
  return state.status === 'lost' ? { lost: true } : null
}

let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

async function restoreTabAffinity(): Promise<void> {
  let record: StoredAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const keptActiveTabId = (candidate as { keptActiveTabId?: unknown } | undefined)?.keptActiveTabId
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
        ...((candidate as { pinned?: unknown }).pinned === true ? { pinned: true as const } : {}),
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      record = { lost: true }
    }
    lastPersistedAffinity = record === null ? undefined : JSON.stringify(record)
  } catch {
    // session 存储只是个辅助，不是禁用 bridge 的理由。
  }

  if (record !== null && 'controlledTabId' in record) {
    try {
      const tab = await chrome.tabs.get(record.controlledTabId)
      const summary = summarizeTab(tab)
      if (summary === null) affinity.restoreLost()
      else affinity.restoreControlled(summary)
    } catch {
      affinity.restoreLost()
    }
  } else if (record?.lost === true) {
    affinity.restoreLost()
  }

  // 先恢复 pin，再去同步活动 tab：否则这次同步会弹出交接提示，
  // 去问一个用户早说过别再问的切换。
  if (record !== null && 'pinned' in record && record.pinned === true) affinity.restorePinned()
  // 切换偏好是设置，所以它压过往记的 pin：模式才是用户要的，pin 只是他们当时给过的答案。
  affinity.setSwitchMode(settings.tabSwitch)
  await syncActiveTab()
  if (record !== null && 'keptActiveTabId' in record) {
    const state = affinity.snapshot()
    if (state.status === 'handoff' && state.active?.tabId === record.keptActiveTabId) {
      affinity.decide('keep', state.revision)
    }
  }
  persistTabAffinity()
  broadcastState()
}

function affinityFailure(kind: 'handoff' | 'lost' | 'missing'): ToolAnswer {
  if (kind === 'handoff') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The user switched tabs, so browser operations are paused. Open the dsh browser control strip and choose whether to keep the previous page or follow the current one.' },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Open the dsh browser control strip and bind the current page before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** 解析出一个稳定的 tab 目标，同时不让一次手动切换把它带偏。 */
async function resolveToolTab(): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = affinity.resolveTarget()
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      // 用户还没做过任何选择时的第一次浏览器调用：绑到用户当前所在的 tab。
      const active = await syncActiveTab()
      const summary = active === undefined ? null : summarizeTab(active)
      if (summary === null) return affinityFailure('missing')
      if (affinity.bindInitial(summary)) {
        persistTabAffinity()
        broadcastState()
      }
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (affinity.observeTab(summary)) broadcastState()
      const current = affinity.resolveTarget()
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      if (affinity.removeTab(resolution.tab.tabId)) {
        persistTabAffinity()
        broadcastState()
      }
      return affinityFailure('lost')
    }
  }
  return affinityFailure('handoff')
}

/** 给 browser_open_tab 挑一个窗口，不要求已经有受控页面。 */
async function resolveOpenTabWindow(): Promise<{ windowId: number } | ToolAnswer> {
  await affinityReady
  const resolution = affinity.resolveTarget()
  if (resolution.kind === 'handoff') return affinityFailure('handoff')
  if (resolution.kind === 'target') {
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      return { windowId: tab.windowId }
    } catch {
      // 受控 tab 已经没了，就退到聚焦窗口上。
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return { windowId: focused.id }
  } catch {
    // 没有聚焦窗口：退到最后聚焦窗口的活动 tab。
  }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (fallback?.windowId !== undefined) return { windowId: fallback.windowId }
  return affinityFailure('missing')
}

function bindOpenedTab(tab: chrome.tabs.Tab, active: boolean): boolean {
  const summary = summarizeTab(tab)
  if (summary === null) return false
  bindOpenedTabAffinity(affinity, summary, { active })
  persistTabAffinity()
  broadcastState()
  return true
}

/** 落实一次明确的 tab 交接，顺带清掉陈旧的元素引用。 */
function commitTabAffinityRebind(summary: AffinityTab, mode: 'active' | 'controlled'): void {
  const previous = affinity.snapshot().controlled?.tabId
  if (mode === 'active') affinity.rebindActive(summary)
  else affinity.rebindControlled(summary)
  if (previous !== undefined && previous !== summary.tabId) resetTabSnapshot(previous)
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastState()
}

/**
 * 把浏览器控制权挪到用户正在看的那个 tab 上。
 *
 * 截止时间说了算：调用方的 signal 一中止，迟到才解析出来的查询就绝不能动绑定。
 * 动了它，等于让一次用户已经看到失败的请求，在他们背后换掉受控 tab。
 */
async function rebindToActiveTab(signal: AbortSignal): Promise<void> {
  await affinityReady
  if (signal.aborted) throw rebindCancelled()
  const tab = await syncActiveTab(undefined, signal)
  if (signal.aborted) throw rebindCancelled()
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new Error(getUiLocale() === 'zh'
      ? '无法确定当前标签页，原绑定保持不变'
      : 'The current tab could not be determined; the existing binding was left unchanged')
  }
  commitTabAffinityRebind(summary, 'active')
}

function rebindCancelled(): Error {
  return new Error(getUiLocale() === 'zh' ? '标签页绑定已超时' : 'Tab binding timed out')
}

// ---- 审批 ----

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of controlPorts) {
    try {
      port.postMessage({ type: 'approval.request', request } satisfies ControlMessage)
      delivered = true
    } catch {
      // 检查之后、发送之前，视图被关掉了。
    }
  }
  return delivered
}

/**
 * 把一个待处理的决定送到用户的桌面端。
 *
 * 弹窗关着就意味着这个请求本来会不可见，所以这条通知刻意*不*受"系统通知"设置的约束：
 * 那个设置是在"发通知"和"控制条内静默投递"之间做选择，而把两者都静音会让一次 fail-closed
 * 的工具调用无路可走。
 */
function notifyApproval(request: ApprovalRequest): void {
  if (controlPorts.size > 0) return
  const zh = getUiLocale() === 'zh'
  const minutes = Math.round(APPROVAL_TIMEOUT_MS / 60_000)
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: zh ? 'dsh 浏览器扩展等待确认' : 'dsh Browser Extension awaits approval',
    message: zh
      ? `${request.summary} —— 点击打开侧边栏，并在 ${minutes} 分钟内允许或拒绝。`
      : `${request.summary} — click to open the side panel and allow or deny within ${minutes} minutes.`,
    requireInteraction: true,
  })).catch(() => {
    // 没有通知权限、或通道被静音：工具栏徽标仍然标记着这个待处理请求，所以改成直接打开
    // 面板。
    openControlPanel()
  })
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: (request) => { notifyApproval(request) },
  clearNotification: clearApprovalNotification,
  resolved: () => {
    syncBadge()
    broadcastState()
  },
})

/** 授权一次工具调用，并把结果记入活动列表。 */
async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  entryId: string,
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (unrestrictedAccessEnabled()) return 'approved'
  if (actionCoveredByTrustedOrigins(prompt, sessionTrustedActionOrigins, settings.trustedActionOrigins)) {
    return 'approved'
  }
  recordActivity({
    id: entryId,
    kind: 'tool',
    name: prompt.action,
    summary: prompt.summary,
    origin: prompt.origins[0] ?? null,
    state: 'running',
  })
  const result: ApprovalRequestResult = await approvals.request(prompt, signal)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  // 留着是为了跟更老的控制条保持 wire 兼容；永久信任由控制条的高级区域显式管理。
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

function unrestrictedAccessEnabled(): boolean {
  return settings.unrestrictedBrowserAccess
}

// ---- gateway 会话 ----

/**
 * 这个 worker 会调用的全部 gateway 方法。
 *
 * 对话归桌面 dsh 应用所有，所以 worker 正好只需要这几个：创建它唯一的会话、排队一条提示、
 * 取消正在跑的轮次，还有——给想要一次持久读取而不是实时流的调用方——取一次历史。
 * 控制页面渲染实时事件并重新提示，而不是重放一份 worker 刻意从不缓存的 transcript。
 */
const sessionRpc = {
  create: (): Promise<unknown> => gatewayRpc('session.create', {}),
  prompt: (sessionId: string, text: string, clientTimeZone: string | undefined): Promise<unknown> =>
    gatewayRpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }),
  cancel: (sessionId: string): Promise<unknown> => gatewayRpc('session.cancel', { sessionId }),
  history: (sessionId: string): Promise<unknown> => gatewayRpc('session.history', { sessionId }),
  follow: (sessionId: string): Promise<unknown> => gatewayRpc('session.follow', { sessionId }),
  /**
   * 声明哪些对话还要继续看，其余的一并放开。
   *
   * 整个请求就是这份保留列表：worker 的镜像才是权威，所以哪怕 bridge 错过了先前的变更，
   * 照样会收敛到同一个集合上。
   */
  retainFollows: (keep: readonly string[]): Promise<unknown> => gatewayRpc('session.unfollow', { keep }),
}

/**
 * 请 bridge 开始把这个对话的事件流式发给这个 worker。
 *
 * 另一件能打开这条流的事情是发一条提示，这也正是过去面板永远只看得见自己的对话、
 * 看不见桌面应用驱动的对话的原因：事件里的 session 只要和面板的绑定对不上就被丢掉，
 * 而光有绑定从来不会把这条流启起来。
 *
 * 刻意做成尽力而为。早于 `session.follow` 的传输层会回一个错误；这种时候面板的绑定
 * 仍然是对的，只是不会实时更新，而这不值得让用户的对话切换失败。
 *
 * 失败会记进 `followErrorRef` 并显示在面板上，因为"已绑定但不更新"和"没内容可显示"
 * 不这样区分就长得一模一样，而常见原因的修法用户猜不到：重启桌面应用，
 * 让它加载一个认识这个方法的 bridge。
 */
let followErrorRef: string | null = null
/**
 * 哪个 follow 请求才有权写 `followErrorRef`。
 *
 * 快速连挑两次会发出两次 follow，结算顺序不定：那个针对用户已经离开的对话的慢失败，
 * 原本会盖掉"他们正在看的那个跟随正常"这条消息。只有最新的请求能写，两个方向都一样——
 * 一次陈旧的成功，同样不许清掉真实的错误。
 */
let followRevision = 0

async function startFollowingSession(sessionId: string): Promise<void> {
  const revision = ++followRevision
  const settleHint = (next: string | null): void => {
    if (revision !== followRevision) return
    if (followErrorRef === next) return
    followErrorRef = next
    try {
      broadcastState()
    } catch {
      // worker 正在关掉，已经没有面板可告知了。
    }
  }
  try {
    // 这里是检查，不是假定：bridge 没了时 `gatewayRpc` 会抛，而一次在 worker 被拆掉之后
    // 才 reject 的 fire-and-forget 调用，会以 unhandled rejection 冒出来——对一个按设计
    // 就允许失败的东西来说，那就是吵闹的控制台加一次测试失败。一次根本没法尝试的 follow
    // 也不当失败上报："未连接"本来就另有提示，为这个去怪 bridge 版本，
    // 只会把用户引向错的修法。
    if (rpc === null || bridge === null || !bridge.connected) return
    await sessionRpc.follow(sessionId)
    settleHint(null)
  } catch (error: unknown) {
    // 刻意吞掉：跟随是尽力而为；下面这个分支会把用户唯一能拿去行动的那种失败，
    // 变成一句面板会显示的话。
    const detail = error instanceof Error ? error.message : String(error)
    settleHint(/unavailable|not-found/iu.test(detail)
      ? (getUiLocale() === 'zh'
          ? '桌面端还没加载新版桥接，面板无法跟随对话。重启 dsh 桌面端后重试。'
          : 'The desktop app has not loaded the new bridge, so the panel cannot follow a conversation. Restart dsh and try again.')
      : detail)
  }
}

/**
 * 连接本身一变，就把常驻的"无法跟随"提示忘掉。
 *
 * 那条提示把原因归到 bridge 版本上，而这只是关于产出它的那条连接的说法：socket 一旦掉落、
 * 重连或者被顶替，那句话就不再已知为真，反复说它只会让用户去做一次也许早就做过的重启。
 * follow 要是还坏着，会自己把这条提示放回来。
 */
function followConnectionChanged(): void {
  followRevision += 1
  if (followErrorRef === null) return
  followErrorRef = null
  try {
    broadcastState()
  } catch {
    // 没有面板可告知。
  }
}

/**
 * 一次 gateway RPC；bridge 载不动它时就早点用一个清楚的错误拒掉。真正的毛病是桌面应用
 * 没连上时，发提示的调用方不该收到一个 30 秒的 socket 超时。
 */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与 token）'
      : 'dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

/** 正在进行中的 `session.create`，免得两条快速提示建出两个会话。 */
let sessionCreation: Promise<string> | null = null

/**
 * 面板的目标对话一换就自增。
 *
 * 用户挑另一个对话时，正在进行中的 `session.create` 不能采用它的结果：回复是在选择做出
 * 之后才到的，放它过去就会悄悄把面板拽回用户刚离开的那个会话——下一条提示也就落进一个
 * 他们没选的对话里。
 */
let sessionGeneration = 0

/**
 * 面板此刻接着用的那个对话。
 *
 * `fresh` 和 `last` 两档共用它：`last` 读它来接着上一段，`fresh` 把它清掉好开新的。
 *
 * 存在 `storage.local` 里，而不是只放这个 worker 的内存里，因为 worker 的寿命没用户想的
 * 那么长。Chrome 会停掉闲置的 MV3 service worker——侧边面板一关就会发生——只存在内存里的
 * 会话跟着就没了。用户的下一条消息于是开了另一个对话，浏览历史碎成每闲置一次超时就多一个
 * 会话，每个都得他们自己去找。
 *
 * 桌面端会把会话落到磁盘上，所以一个 id 跨浏览器重启、跨 dsh 重启、以及两样都来一遍，
 * 都还能用。恢复它才有意义。
 */
const FRESH_SESSION_KEY = 'dshFreshSessionId'

/** 记住"新对话"模式绑的是哪个会话。 */
function rememberFreshSession(sessionId: string | null): void {
  const write = sessionId === null
    ? chrome.storage.local.remove(FRESH_SESSION_KEY)
    : chrome.storage.local.set({ [FRESH_SESSION_KEY]: sessionId })
  // 存储只是辅助，不是前置条件：这里失败绝不能拦下用户正在等的那条提示。
  void Promise.resolve(write).catch(() => {})
}

/**
 * 那个记住的会话——前提是桌面端还持有它。
 *
 * 存下来的 id 可能比它的会话活得久：用户也许已经从桌面端把那个对话删了。采用一个已死的 id
 * 会把下一条提示发向虚无，报出一个用户没法据以行动的 gateway 错误，所以这个 id 要先跟桌面端
 * 自己的列表对一遍。列表读不出来说明桌面端更老，或者只是这次读失败了；
 * 这两种情况都宁可开一个新对话，也不要拒绝发送。
 *
 * @returns 要接着用的 id；null 表示新建一个对话。
 */
async function restoredFreshSession(): Promise<string | null> {
  let stored: unknown
  try {
    const read = await chrome.storage.local.get(FRESH_SESSION_KEY)
    stored = read[FRESH_SESSION_KEY]
  } catch {
    return null
  }
  if (typeof stored !== 'string' || stored === '') return null
  try {
    const sessions = await listSessions()
    if (!sessions.some((session) => session.sessionId === stored)) {
      rememberFreshSession(null)
      return null
    }
  } catch {
    return null
  }
  return stored
}

function ensureSession(): Promise<string> {
  const existing = control.id
  if (existing !== null) return Promise.resolve(existing)
  if (sessionCreation === null) {
    const generation = sessionGeneration
    // 先试着接着用记住的那个对话，这样"新对话"才是"新开一个，然后一直用它，
    // 直到你再要一个"，而不是"worker 每被回收一次就多一个新的"。
    const attempt = restoredFreshSession()
      .then((restored) => {
        if (restored !== null) {
          if (generation === sessionGeneration) control.adopt(restored)
          return restored
        }
        return sessionRpc.create().then((created) => {
          const sessionId = typeof created === 'object' && created !== null
            ? (created as { sessionId?: unknown }).sessionId
            : undefined
          if (typeof sessionId !== 'string' || sessionId === '') {
            throw new Error(getUiLocale() === 'zh'
              ? 'dsh 未返回会话 id'
              : 'The dsh gateway created a session without an id.')
          }
          // 只有还是当前那一次的 create 才能写这个绑定。无条件写的话，一个已被取代的 create
          // 会在用户切换范围之后把自己复活，下一次面板提示就落进他们刚离开的那个对话。
          if (generation === sessionGeneration) {
            rememberFreshSession(sessionId)
            control.adopt(sessionId)
          }
          return sessionId
        })
      })
    sessionCreation = attempt
    const clear = (): void => { if (sessionCreation === attempt) sessionCreation = null }
    void attempt.then(clear, clear)
  }
  return sessionCreation
}

/** 浏览器的 IANA 时区，这样桌面端按用户所在时区渲染时间。 */
function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : undefined
  } catch {
    return undefined
  }
}

/**
 * 把一条键入的指令转发给桌面模型。
 *
 * 文本被打上 {@link BROWSER_PANEL_MARKER} 标记，这样模型能分清一条真正的指令和一段自称是
 * 指令的页面内容。标记在这里、在唯一能提交提示的路径上打上，而不是留给模型去推断。
 *
 * @param text - 用户提交时的原文指令。
 * @returns 这条提示排队所在的会话。
 */
async function promptSession(text: string): Promise<string> {
  const request = control.beginPrompt(text)
  try {
    const sessionId = await ensureSession()
    // await 之后再查一次绑定：`ensureSession` 可能花一次往返去创建或恢复对话，
    // 而用户在这期间可能挑中了另一个。`ensureSession` 里的世代检查只挡住*采用*——
    // 它解析出的 id 照样会返回，所以少了这里这一步，提示会落进他们刚离开的对话，
    // 行却画在他们选中的那个里面。拒绝才是诚实的答复：下一条消息会发到面板实际指向的地方。
    if (control.id !== sessionId) {
      throw new Error(getUiLocale() === 'zh'
        ? '你切换了对话，这条消息没有发出。再发一次就会发到当前选中的对话。'
        : 'You switched conversations, so this message was not sent. Send it again to reach the one now selected.')
    }
    // transcript 行保留原文，这样面板显示的就是用户键入的内容；模型收到的是带标记的版本。
    await sessionRpc.prompt(sessionId, `${BROWSER_PANEL_MARKER} ${text}`, browserTimeZone())
    // 提示本身就会在 bridge 上打开跟随器，所以这只是双保险；而且它跑在提示之后，
    // 永远不会夹在调用方和提示自己的结果中间。
    void startFollowingSession(sessionId)
    control.admitPrompt(request)
    return sessionId
  } catch (error: unknown) {
    // 这个请求行是乐观加上的：一条根本没到桌面端的提示，不能像已经提交过一样留在这次运行里。
    control.rejectPrompt(request)
    throw error
  }
}

/** 判断是不是普通对象，用来收窄跨进程边界过来的值。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读取桌面端最近的对话，给面板的选择器用。
 * 只留选择器会显示的字段，而且每个都校验过：这东西是跨 bridge 从另一个进程来的，
 * 所以形状变了必须降级成一份更短的列表，而不是崩掉、或者冒出一个伪造的 session id。
 *
 * **子代理对话会被丢掉。** 每个被委派的子代理自己就是一个 Session，拿它自己的指令当标题，
 * 所以列表里曾经满是叫 `You are a senior code…`、`You are auditing…` 的条目——
 * 每轮审计三条看起来一模一样的行，没有一条是用户能从面板正经接着聊下去的。
 * 桌面端把它们标成 `origin: 'subagent'` 并带上 `parentSessionId`，
 * 而这份列表讲的是用户手里的对话，不是它们背后的机械装置。
 *
 * @returns 值得挑的对话，正在运行的在前，然后按最近排序。
 */
async function listSessions(): Promise<SessionSummary[]> {
  const listed = await gatewayRpc('session.list', {})
  const items = isPlainObject(listed) && Array.isArray(listed.items) ? listed.items : []
  const sessions: SessionSummary[] = []
  for (const item of items) {
    if (!isPlainObject(item) || typeof item.sessionId !== 'string' || item.sessionId === '') continue
    // 子代理的 Session 不是用户能对话的那种对话。两个字段命中任意一个就算：
    // `origin` 是直接说明，`parentSessionId` 是结构上的说明，
    // 而只发布其中一个的构建也得能过滤掉。
    if (item.origin === 'subagent' || typeof item.parentSessionId === 'string') continue
    // `title` 不是顶层字段：它住在 `projections.values.title` 里，读 `item.title` 什么都读不到，
    // 于是选择器里每个对话都被标成 "Untitled"——所以那儿唯一的毛病并不是标题长得太像。
    // 两种写法都接受，因为扁平的那种是未来构建很可能发布的形状。
    sessions.push({
      sessionId: item.sessionId,
      title: sessionTitleOf(item),
      preview: firstPromptOf(item.projections),
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      running: item.running === true,
    })
  }
  // 有轮次在跑的对话排最前，其后按最近排序。
  //
  // 桌面端不发布"我此刻在显示哪个会话"这种字段，`running` 是最接近的东西：
  // 正在跑轮次的那个对话几乎总是屏幕上的那个；而丢掉子代理之后，
  // 列表已经短到单靠"最近的在前"就是一个能用的顺序。
  sessions.sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1
    return right.updatedAt - left.updatedAt
  })
  return sessions
}

/**
 * 「全部工作区」该镜像哪些对话。
 *
 * 早先这一档只镜像一个工作区：`bridgePolicy.sessionWorkspacePath` 指的那个目录（bridge 在
 * `hello.ok` 里说出来的那份），理由是那才是扩展自己的浏览器对话所在的地方。现在按用户的
 * 要求放宽成**每一个工作区**——"不管我在 DSH 哪个工作区发对话，都同步到插件里"——所以
 * 这里不再按路径筛选，`workspace.list` 报出来的每个分组都算。
 *
 * 代价是分组越多、要跟的对话越多，所以活跃筛选（见 {@link sessionsWorthFollowing}）是
 * 这条路的必需部分，不是优化。
 *
 * @returns id → 标签；一个分组都没开、或者里面都还没东西时为空。
 */
async function workspaceSessions(options: { onlyActive: boolean }): Promise<Map<string, string>> {
  const mirror = new Map<string, string>()
  const listed = await gatewayRpc('workspace.list', {})
  const items = isPlainObject(listed) && Array.isArray(listed.items) ? listed.items : []
  // 「全部工作区」是这一档的定义：每一个工作区的对话都算，不只是浏览器工作区。所以这里刻意
  // **不**按 `bridgePolicy.sessionWorkspacePath` 过滤 —— 那个路径标识的是扩展自己用的工作区，
  // 而用户要的是"不管我在哪个工作区发对话，都同步到插件里"。
  const memberIds = new Map<string, string>()
  for (const item of items) {
    if (!isPlainObject(item) || !Array.isArray(item.sessionIds)) continue
    const title = typeof item.title === 'string' && item.title !== '' ? item.title : undefined
    for (const id of item.sessionIds) {
      if (typeof id !== 'string' || id === '') continue
      // 同一段对话可以同时属于多个工作区；留第一个有名字的标题就是了。
      if (title !== undefined && !memberIds.has(id)) memberIds.set(id, title)
      else if (!memberIds.has(id)) memberIds.set(id, '')
    }
  }
  if (memberIds.size === 0) return mirror

  if (!options.onlyActive) {
    // 刚进这个模式：先把每个工作区都镜像一遍，这样某个对话的工作哪怕发生在这条连接之前，
    // 它也会出现在屏幕上。被跟随的流会送来快照，正是靠它把已有的 transcript 显出来，
    // 而不只是显示之后发生的事。
    for (const [id, title] of memberIds) mirror.set(id, title)
    return mirror
  }

  // 稳态：只跟还在产出东西的那几个对话 —— 分组会无限长大，全部跟住就是每个成员一条
  // 服务端流，只为看那一两个活跃的。
  const worth = new Set(sessionsWorthFollowing(new Set(memberIds.keys()), await listSessions(), Date.now()))
  for (const [id, title] of memberIds) {
    if (worth.has(id)) mirror.set(id, title)
  }
  return mirror
}

/** 最后一次事件早于这个时间的对话，就不值得再跟了。 */
export const RECENT_ACTIVITY_MS = 5 * 60_000

/**
 * 一个分组里哪些对话现在值得跟。
 *
 * 就是它让「工作区内」保持便宜。跟一个工作区的每个成员，意味着每个成员一条服务端流，
 * 只为看那一两个活跃的；而对话越攒越多，分组会无限长大。活跃不活跃，`session.list` 的元数据
 * 就能回答，不用去问任何 Session：`updatedAt` 在对话产出事件时往前走、不产出就原地不动，
 * `running` 标记有没有轮次在跑。于是一个开始干活的对话就"最近"，下一次 tick 被跟上；
 * 一个安静下来的对话离开这个窗口，被丢掉。
 *
 * 做成纯函数并导出，是为了直接测这个判断，而不是通过一个非得等它跑完的定时器。
 *
 * @param memberIds - 这个分组里的每一个对话。
 * @param active - 桌面端的会话列表，worker 读到的样子。
 * @param now - 当前时间，注入进来方便测这个窗口。
 * @returns 要跟随的 id，顺序跟着 `active` 报告的顺序（最近的在前）。
 */
export function sessionsWorthFollowing(
  memberIds: ReadonlySet<string>,
  active: readonly { sessionId: string; updatedAt: number; running: boolean }[],
  now: number,
): string[] {
  const cutoff = now - RECENT_ACTIVITY_MS
  const wanted: string[] = []
  for (const session of active) {
    if (!memberIds.has(session.sessionId)) continue
    if (!session.running && session.updatedAt < cutoff) continue
    wanted.push(session.sessionId)
  }
  return wanted
}

/**
 * 一个对话最后一次事件要多新，「工作区内」才继续跟它。
 *
 * 够长，一段正在被读或被想的对话不会用着用着就被丢掉；又够短，二十个的分组会收敛到活跃的
 * 那一两个。拿来比的是 `updatedAt`，它只在对话产出事件时往前走，
 * 所以这问的是"这儿最近有没有动静"，不是猜。
 *
 * 声明在上面 {@link sessionsWorthFollowing} 旁边；这段注释就是它的理由。
 */

/**
 * 镜像里最新的那个对话；分组为空时返回 null。
 *
 * 用作「工作区内」下面板的绑定：在那里键入会启动面板自己的对话，但 transcript 总得*关于*
 * 点什么，而分组里最近有动静的那个对话，就是用户正在看的那个。
 *
 * @param mirror - 被镜像的对话。
 * @returns 一个 session id，或 null。
 */
function newestMirrored(mirror: ReadonlyMap<string, string>): string | null {
  // 这个 map 保持插入顺序，而 `workspace.list` 是按最近的在前报的，所以第一个键就是最新的。
  // 一个时间戳都不用，所以顺序由桌面端决定的分组照样适用。
  return [...mirror.keys()][0] ?? null
}

/**
 * 开始镜像浏览器工作区里的每个对话。
 *
 * 每一个都得打开跟随器：bridge 只在有人要求之后才流式发送某个对话的事件，而面板从来不会去
 * 提示其中的大多数。某一个打不开可以容忍——其他对话照样被镜像，
 * 而在一个已经跟随着的对话上再调 `session.follow` 很便宜。
 *
 * @param options.onlyActive - 稳态下为 true，只跟活跃的对话；刚进来时为 false，
 *   把整个分组镜像一遍。
 * @returns 被镜像的集合，方便调用方发布给面板。
 */
/**
 * 这个 worker 已经请 bridge 流式发送过的对话。
 *
 * 记着它是为了让一次刷新 tick 只问新增的部分。对 bridge 已经在读的 Session 来说，
 * `session.follow` 是幂等的，重复请求不算错——但一个每次都把所有被镜像对话重新声明一遍的
 * tick，会每个 tick 为每个对话花一次往返，却什么都没变。
 */
const followedSessions = new Set<string>()

async function startWorkspaceMirror(options: { onlyActive: boolean } = { onlyActive: true }): Promise<Map<string, string>> {
  const mirror = await workspaceSessions(options)
  control.setMirrored(mirror)
  for (const id of mirror.keys()) {
    if (followedSessions.has(id)) continue
    followedSessions.add(id)
    void startFollowingSession(id)
  }
  // 把镜像已经放手的那些对话的流释放掉，二十个的分组才不会为了看活跃的一两个而攥着二十条
  // 服务端流。声明的是保留的集合，不是丢弃的那个，所以 bridge 哪怕漏掉了先前的变更，
  // 最终也会正好持有这个 worker 正在显示的东西。
  retainFollowedSessions(new Set(mirror.keys()))
  // 这些行属于那个已经不再显示它们的镜像。
  control.retainSessions(new Set(mirror.keys()))
  const newest = newestMirrored(mirror)
  if (newest !== null) control.adopt(newest)
  return mirror
}

/**
 * 告诉 bridge 还有哪些对话在看。
 *
 * 发了就不管，刻意做成尽力而为。两个理由，都是为用户着想，不是为了整齐：
 *
 * - 早于 `session.unfollow` 的 bridge 会回一个错误，而那个错误绝不能从哪儿冒出来。
 *   扩展和 bridge 是分开升级的——一个走商店，一个走 npm——所以老的组合必须照样能用，
 *   只是没有释放这一步。退化成"流多攥了一会儿"是对的；为这个让一次刷新 tick 失败就不对了。
 * - 这只是记账。一次发不出去的 tick，面板该更新的还是更新了。
 *
 * @param keep - 仍在被镜像的 Session id。
 */
function retainFollowedSessions(keep: ReadonlySet<string>): void {
  let dropped = false
  for (const id of [...followedSessions]) {
    if (keep.has(id)) continue
    followedSessions.delete(id)
    dropped = true
  }
  // 什么都没释放，也就没什么要声明的。刷新 tick 上多数时候都这样，而且不花任何往返。
  if (!dropped) return
  void sessionRpc.retainFollows([...keep]).catch(() => {
    // 要么是更老的 bridge，要么是中途关掉的 socket。不管哪种，它手里剩的流都会跟着连接一起
    // 结束。
  })
}

/** 停止镜像，丢掉那些额外对话的行，连带它们的跟随记账。 */
function stopWorkspaceMirror(): void {
  control.setMirrored(new Map())
  control.retainSessions(new Set())
  retainFollowedSessions(new Set())
  followedSessions.clear()
}

/**
 * 一个对话的显示名，从装着它的那个字段里取。
 *
 * 桌面端把它塞在 `projections.values.title`；扁平的 `title` 也认。无标题的对话合法地就是
 * 空字符串，选择器会用回退标签渲染它——关键是把这种情况和"标题只是找错地方了"分开。
 *
 * @param item - 一条 `session.list` 条目。
 * @returns 标题；条目没有标题时返回 `''`。
 */
function sessionTitleOf(item: Record<string, unknown>): string {
  if (typeof item.title === 'string') return item.title
  const projections = item.projections
  if (!isPlainObject(projections) || !isPlainObject(projections.values)) return ''
  const title = projections.values.title
  return typeof title === 'string' ? title : ''
}

/**
 * 一个对话的开头提示，压成短短一行。
 *
 * 来源是 `projections.values.turnOutline`，它带着每一轮的第一条用户消息和回复摘要。
 * 两个标题可以几乎一样（"介绍哔哩哔哩罗肖尼视频" 对 "哔哩哔哩罗肖尼视频介绍"），
 * 但它们背后的提示差别明显，所以正是它让选择器有得挑。每一步都是防御性的——
 * 这形状跨进程边界——读不出来的那一步给空字符串，而不是给一行错的内容。
 *
 * @param projections - 一条 `session.list` 条目的 `projections` 值。
 * @returns 第一条提示，空白已折叠；取不到时返回 `''`。
 */
function firstPromptOf(projections: unknown): string {
  if (!isPlainObject(projections)) return ''
  const values = projections.values
  if (!isPlainObject(values) || !Array.isArray(values.turnOutline)) return ''
  for (const turn of values.turnOutline) {
    if (!isPlainObject(turn) || typeof turn.prompt !== 'string') continue
    const prompt = turn.prompt.replace(/\s+/gu, ' ').trim()
    // 有些轮次带的是空提示（续写那种）；接着找一条真提示。
    if (prompt === '') continue
    return prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt
  }
  return ''
}

/**
 * 把面板指向某个对话，或者重新给它自己的对话。
 *
 * 换档都会丢掉当前绑定（`last` 与 `fresh` 的差别只在"要不要沿用记住的那段"，不是"立刻绑上去"），
 * 下一条提示才决定用哪段对话。两个方向都会清掉没跑完的 `session.create`，让一次在路上的提示
 * 无法把用户刚离开的会话复活过来。
 *
 * @param scope - 要切到的那一档。
 */
async function selectSessionScope(scope: SessionScope): Promise<void> {
  // 换目标之前先把还在路上的 create 作废，它的回复就没法采用一个用户刚离开的会话。
  sessionGeneration += 1
  sessionCreation = null
  // 已经开跑的工作能活过这次切换；只是排着队的不能，因为它马上要在被切走的那个对话上跑。
  const keep = control.inFlightRowIds(activeToolCalls.keys())
  if (scope === 'workspace') {
    // 镜像不改变提示的归属：面板留着自己的对话，所以在这儿键入不可能意外落进某个被镜像的
    // 对话。被镜像对话的行是增量的，所以只有离开分组的那些会被丢掉。
    publishedMirror = new Map()
    control.detach(keep)
    await persistSettings({ sessionScope: 'workspace' })
    // 进来时先取整个分组，桌面端早先驱动过的对话才看得见，而不只是从现在起发生的事。
    // 下面的刷新接着只跟活跃的那些，靠的正是不让二十个闲置对话花掉二十条服务端流。
    await startWorkspaceMirror({ onlyActive: false })
    startWorkspaceRefresh()
    broadcastState()
    return
  }
  // 离开工作区模式：先停掉镜像，再让那个唯一绑定接管，它的行就不会被镜像留下来。
  stopWorkspaceRefresh()
  stopWorkspaceMirror()
  if (scope === 'last') {
    // 「上次浏览器对话」：不动记住的那段，下一次提示由 `ensureSession` 接着用它
    //（`restoredFreshSession()` 会先核对桌面端是否还持有它）。这里刻意什么都不绑：
    // 绑定是下一次提示的事，用户可能只是想改设置、并不打算立刻说话。
    control.detach(keep)
  } else {
    // 「新建对话」：把记住的那段忘掉。不在这儿忘，下一条提示就会接着用用户刚要求
    // 离开的那个会话——这个选择必须算数。
    rememberFreshSession(null)
    control.detach(keep)
  }
  await persistSettings({ sessionScope: scope })
  broadcastState()
}

/**
 * 「工作区内」多久重读一次分组，好让一个开始干活的对话自动被接上。
 *
 * 十秒是这个模式能接受的折中：一个 tick 读两次元数据，而且只给结果是活跃的对话打开跟随器，
 * 所以"早"几乎不花钱，而"晚"的代价是桌面侧的工作出现前有一段延迟。
 * 用赋值而不是 `const` 声明，是因为想演练这个定时器的测试得够得着它；
 * 而把它做成用户设置，会变成一个只有默认值有用的旋钮。
 */
export let WORKSPACE_REFRESH_MS = 10_000

/** 「工作区内」的刷新定时器，以及它上次发布的分组。 */
let workspaceTimer: ReturnType<typeof setInterval> | null = null
let publishedMirror = new Map<string, string>()

/** 模式开着的时候，让被镜像的集合保持最新。 */
function startWorkspaceRefresh(): void {
  stopWorkspaceRefresh()
  workspaceTimer = setInterval(() => {
    void startWorkspaceMirror().then(
      (mirror) => {
        // 只在分组真的变了才重绘：面板每次状态推送都会重渲染，
        // 无条件推送的定时器只会毫无理由地每十秒重绘一次这个对话。
        if (sameMirror(mirror, publishedMirror)) return
        publishedMirror = new Map(mirror)
        broadcastState()
      },
      () => { /* 这次读取失败了：下一个 tick 再试。 */ },
    )
  }, WORKSPACE_REFRESH_MS)
  // Node 和 worker 都会因为一个挂着的 interval 而让进程活着；
  // 这个只是记账，绝不能成为 worker 继续跑的理由。
  const timer = workspaceTimer as unknown as { unref?: () => void }
  timer.unref?.()
}

/** 停止刷新被镜像集合。 */
function stopWorkspaceRefresh(): void {
  if (workspaceTimer !== null) clearInterval(workspaceTimer)
  workspaceTimer = null
  publishedMirror = new Map()
}

/**
 * 两个被镜像集合指名的是不是同一批对话。
 *
 * 顺序也算数：最新的对话决定面板的绑定，所以成员完全一样时，光重排一次也是真的变了。
 *
 * @param left - 一个集合。
 * @param right - 另一个。
 * @returns 两者等价时返回 true。
 */
function sameMirror(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false
  const leftKeys = [...left.keys()]
  const rightKeys = [...right.keys()]
  return leftKeys.every((id, index) => id === rightKeys[index])
}

/** `@open` 每步之间停多久（毫秒），按 pace 算。 */
const OPEN_PACE_MS: Record<'fast' | 'normal' | 'slow', number> = {
  fast: 0,
  normal: 350,
  slow: 1_200,
}

/**
 * 在用户眼前打开一个 URL，然后把它交给工具。
 *
 * `@open` 指令的全部行为就是这个，每一步都在这里做完，不由模型做：开 tab、带到前台、等文档、
 * 绑成受控 tab、把面板抬起来。所以"这样我就能看着它"是保证——模型跳不过去，
 * 因为干这事的不是模型。
 *
 * @param url - 要打开的地址；只接受 http(s)。
 * @param pace - 每步之间停多久，好让人跟得上。
 * @param pin - 打开的 tab 要不要成为工具作用的那个 tab。
 * @returns 一段给面板显示的简短事实说明。
 */
async function openInFrontOfUser(
  url: string,
  pace: 'fast' | 'normal' | 'slow',
  pin: boolean,
): Promise<{ url: string; tabId: number; pinned: boolean }> {
  // 这项权限归桌面应用所有。`@open` 虽然由用户发起，但它仍然是代表用户打开页面，
  // 所以一个拦不住它的开关就是个不工作的开关。
  if (!pagesMayBeOpened()) {
    throw new Error(getUiLocale() === 'zh'
      ? '「自动打开页面」已在桌面端关闭，因此 @open 不可用'
      : 'Opening pages is turned off in the desktop app, so @open is unavailable.')
  }
  const parsed = parseHttpUrl(url)
  if (parsed === undefined) {
    throw new Error(getUiLocale() === 'zh'
      ? `只能打开 http 或 https 网址，收到：${url}`
      : `Only http or https addresses can be opened; received: ${url}`)
  }
  const step = OPEN_PACE_MS[pace]
  const pause = async (): Promise<void> => {
    if (step > 0) await new Promise<void>((resolve) => { setTimeout(resolve, step) })
  }

  await settingsReady
  const windowId = await resolveOpenTabWindow()
    .then((resolved) => ('windowId' in resolved ? resolved.windowId : undefined))
    .catch(() => undefined)
  await pause()
  const created = await chrome.tabs.create({
    // 刻意放前台：用户就是要看着这事发生。
    active: true,
    ...(windowId === undefined ? {} : { windowId }),
  })
  if (created.id === undefined) throw new Error('Chrome created a tab without an id.')
  const tabId = created.id

  await pause()
  // 绑定前先等文档，模型拍的第一张快照才是真实页面的，而不是 about:blank。
  const navigationWait = waitForNextDocumentReady(tabId, 0, undefined, new AbortController().signal)
  await chrome.tabs.update(tabId, { url: parsed.href })
  await navigationWait.ready

  if (pin) {
    await pause()
    const tab = await chrome.tabs.get(tabId)
    if (!bindOpenedTab(tab, true)) {
      // 元数据拿不到也照样按 id 绑：用户要的就是这个 tab，
      // 描述不出来绝不能变成悄悄把工具指去别处。
      affinity.rebindControlled({ tabId, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? parsed.href })
      persistTabAffinity()
      broadcastState()
    }
  }

  await pause()
  // 从面板消息上拿不到手势，所以这是尽力而为：面板通常已经开着，被拒也绝不能让指令失败。
  void chrome.windows.getLastFocused()
    .then((focused) => { openControlPanel(focused.id) })
    .catch(() => { openControlPanel() })

  return { url: parsed.href, tabId, pinned: pin }
}

/** 停掉 worker 会话里正在跑的轮次。 */
async function cancelSession(): Promise<string> {  const sessionId = control.id
  if (sessionId === null) {
    throw new Error(getUiLocale() === 'zh'
      ? '当前没有可取消的 dsh 会话'
      : 'There is no dsh session to cancel yet.')
  }
  await sessionRpc.cancel(sessionId)
  control.cancelTurn()
  return sessionId
}

// ---- 工具派发 ----

export function answerOutcome(answer: ToolAnswer): ActivityEntry['state'] {
  if (answer.ok) return 'done'
  if (answer.error?.code === 'bridge-closed') return 'cancelled'
  if (answer.error?.code === 'timeout') return 'failed'
  return 'failed'
}

/**
 * 一次浏览器操作带着多大的权限跑。
 *
 * `unrestricted` 会跳过所有审批提示。bridge 那条路只在用户开了全局开关时才给；键盘输入的命令
 * 永远有，因为敲下这条命令本身就是用户的手势。
 */
type ToolAccessMode = 'prompt' | 'unrestricted'

/** 一次浏览器操作，不管是谁发起的。 */
interface ToolRun {
  call: ToolCall
  /** 在操作到页面之前把它撤回。 */
  controller: AbortController
  /** 请求的来源：一次模型步骤，或者用户自己敲的命令。 */
  kind: ActivityEntry['kind']
  access: ToolAccessMode
}

/**
 * 描述快照编号里的一张图片，再拿答案跟页面对一遍。
 *
 * 启动识别的地方只有这里，而且是按需启动：问到哪张图才为哪张图发请求。识别一张图要花一次
 * 请求，一个页面却能装几十张，所以这里的规矩是排一下就够，不必蛮干——而答案已经缓存的图片
 * 一分钱不花。
 *
 * @param call - 工具调用，带着图片 index。
 * @param tab - affinity 选中的 tab。
 * @param sharePageContent - 用户的页面内容策略。
 * @param signal - bridge 的生命周期。
 * @returns 工具答案：交叉校验过的描述，或者描述不了的原因。
 */
async function describeImage(
  call: ToolCall,
  tab: Pick<chrome.tabs.Tab, 'id'>,
  signal: AbortSignal,
): Promise<ToolAnswer> {
  // 图片就是页面内容，字节要离开这台机器。这里原先还有一条 `'off'` 的拒绝分支，
  // 但那一档已经不存在了（见 `Settings.sharePageContent`）—— 而它当年其实也不生效：
  // 出厂即开的 `unrestrictedBrowserAccess` 会把这一档盖成 `'auto'`。
  const visionService = vision()
  if (settings.visionTier === 'off') {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'Image recognition is off. Enable a tier in Settings > Image recognition to allow it.',
      },
    }
  }
  if (!visionService.canRecognize()) {
    // 桌面端知道它为什么识别不了，也写在握手里了；不把它带出来，读者面前就是死路一条。
    const hint = bridgePolicy?.imageRecognitionHint
    return {
      ok: false,
      error: {
        code: 'content-unavailable',
        message: 'No vision model is configured for image recognition, so this image cannot be described.'
          + (typeof hint === 'string' && hint !== '' ? ` ${hint}.` : ''),
      },
    }
  }
  // 这里刻意不做任何强制转换。`Number(null)` 是 0，`Number('')` 也是 0，所以只要放宽到"像数字
  // 就收"，`index: null` 就变成"描述第一张图片"——悄没声地描述错的那张图。工具派发那条路已经
  // 拒绝非整数 index，而这条路回答的是同一个工具。
  const index = call.args.index
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    return {
      ok: false,
      error: { code: 'bad-args', message: 'index must be the non-negative number browser_snapshot listed for the image.' },
    }
  }
  if (tab.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  // 元素 index 是按 frame 各自编号的，所以图片显示在哪个 frame 下，属于怎么找到它的一部分，
  // 而不是可选的精修。给不出可用的值就拒绝，不取默认值——取默认值描述的是 frame 0 恰好有的
  // 东西，不是模型指的那个。
  const rawFrame = call.args.frame
  const frameId = rawFrame === undefined ? 0 : rawFrame
  if (typeof frameId !== 'number' || !Number.isSafeInteger(frameId) || frameId < 0) {
    return {
      ok: false,
      error: { code: 'bad-args', message: 'frame must be a non-negative integer returned by browser_snapshot, or omitted.' },
    }
  }
  const resolved = await requestImageTarget(tab.id, index, frameId, signal)
  if (!resolved.ok) return resolved
  const image = resolved.target

  // 优先要扩展取来的字节，因为只有它带着用户的登录状态；URL 是自己的 fetch 够不着时的兜底。
  // 缓存排在这一切之前，按 identity 查，所以再问一张描述过的图片不会重新下载——这笔成本是
  // 从 manifest 不再把每个真实主机都拦下来的那一刻起出现的。
  const alreadyAnswered = visionService.descriptionOf(image.identity) !== undefined
  const chosen = await chooseImageSource(image.src, alreadyAnswered)
  const source = chosen.source
  if (source === undefined) {
    return {
      ok: true,
      result: {
        text: `Image [${String(index)}] has no address and no readable bytes, so it cannot be described.`,
      },
    }
  }

  const outcome = await visionService.describe(
    { identity: image.identity, alt: image.alt, near: image.near, heading: image.heading, kind: image.kind },
    source,
    signal,
    settings.visionTier,
  )
  const byteFailure = chosen.byteFailure
  return { ok: true, result: { text: describeOutcomeText(index, outcome, byteFailure) } }
}

/**
 * 在 affinity 选中的 tab 上跑一次浏览器操作。
 *
 * 派发路径只有这一条：bridge 来的 `tool.call` 帧和键盘敲的命令，差别只在于各自构建的
 * {@link ToolRun}，所以 tab affinity、frame 校验、受保护页面的拒绝，以及 `dispatchToolCall`
 * 里的每一道守卫对两者同样有效，谁也不会跟另一边跑偏。
 */
async function executeToolCall(run: ToolRun): Promise<ToolAnswer> {
  const { call, controller, access } = run
  const unrestricted = access === 'unrestricted'
  control.addStep(call.id, call.name, activitySummary(call, { ok: true }))
  if (run.kind === 'command') {
    // 键盘敲的命令从不等待审批，派发出去就是在跑。模型调用则是靠它的第一条活动记录走到
    // `running`；对一次要走门控的调用来说，那条记录是在审批提示弹出来的时候写下的。
    control.startStep(call.id)
  }
  const authorize = (prompt: ApprovalPrompt): Promise<ApprovalAuthorization> => {
    if (unrestricted) return Promise.resolve('approved')
    return authorizeToolCall(prompt, controller.signal, call.id)
  }
  const budget = currentBudget()
  const sharePageContent = unrestricted ? 'auto' : settings.sharePageContent
  const tabManagement: TabManagementContext = {
    unrestrictedAccess: unrestricted,
    controlledTabId: affinity.snapshot().controlled?.tabId,
    followTab: async (tab) => {
      const summary = summarizeTab(tab)
      if (summary === null) throw new Error('the selected tab has no usable identifier')
      commitTabAffinityRebind(summary, 'controlled')
    },
  }

  if (isTabManagementTool(call.name)) {
    return dispatchToolCall(call, sharePageContent, budget, authorize, controller.signal, undefined, undefined, tabManagement, visionSink())
  }
  if (call.name === 'browser_open_tab') {
    const target = await resolveOpenTabWindow()
    if ('ok' in target) return target
    return dispatchOpenTab(
      call,
      target.windowId,
      sharePageContent,
      budget,
      authorize,
      controller.signal,
      (tab) => bindOpenedTab(tab, call.args.active !== false),
      (tabId) => affinity.allowsTarget(tabId),
      undefined,
      visionSink(),
    )
  }
  const target = await resolveToolTab()
  if ('ok' in target) return target
  // 图片描述另走一条派发：它要的是解析出来的 tab、页面内容策略和视觉流水线，
  // 而不是一次页面操作。
  if (call.name === 'browser_describe_image') {
    return await describeImage(call, target, controller.signal)
  }
  return dispatchToolCall(
    call,
    sharePageContent,
    budget,
    authorize,
    controller.signal,
    target,
    () => target.id !== undefined && affinity.allowsTarget(target.id),
    { unrestrictedAccess: unrestricted },
    visionSink(),
  )
}

/** 把 tool.call 帧送到用户批准的那个受控 tab 上。 */
function routeToolCall(call: ToolCall): void {
  const socket = bridge
  if (socket === null) return
  // 模型马上要驱动浏览器，先把面板放到用户看得见的地方。每一次浏览器操作都会走到这里，
  // 唯一的一处，不需要审批的操作也算。
  autoOpenPanel()
  // 帧带来的 id 如果已经在 map 里，就会替换掉那个条目；被替换的调用随后在下面的身份检查处
  // 提前返回——它一次性的 `settle()` 于是永远不触发，`cancelAllToolCalls()` 也再也够不着它，
  // 因为它已经不是 map 的占用者了。`settled` 正是撤销屏障等的东西，所以一个没结算的孤儿会
  // 永远挂着 `revokeUnrestrictedAccess()`，用户按下的"关"永远传不到存储。
  // 在这里结算它是安全的：这个 promise 是一次性的，而这次调用本来就要被放弃。
  const superseded = activeToolCalls.get(call.id)
  if (superseded !== undefined) {
    superseded.controller.abort()
    superseded.settle()
  }
  const controller = new AbortController()
  let settle!: () => void
  const activeCall: ActiveToolCall = {
    controller,
    unrestricted: unrestrictedAccessEnabled(),
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeToolCalls.set(call.id, activeCall)
  const result = (answer: ToolAnswer, state: ActivityEntry['state']): void => {
    if (activeToolCalls.get(call.id) !== activeCall) return
    if (settleOnCompletion(activeCall)) activeToolCalls.delete(call.id)
    recordActivity({ id: call.id, kind: 'tool', name: call.name, summary: activitySummary(call, answer), origin: null, state })
    if (controller.signal.aborted && !(call.name === 'browser_open_tab' && answer.ok)) {
      socket.send({ t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'Tool call was cancelled' } })
      return
    }
    if (answer.ok) socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
    else socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
  }
  const fail = (error: unknown): void => {
    if (activeToolCalls.get(call.id) !== activeCall) return
    if (settleOnCompletion(activeCall)) activeToolCalls.delete(call.id)
    recordActivity({ id: call.id, kind: 'tool', name: call.name, summary: call.name, origin: null, state: 'failed' })
    socket.send({
      t: 'tool.result',
      id: call.id,
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    })
  }

  void executeToolCall({
    call,
    controller,
    kind: 'tool',
    access: activeCall.unrestricted ? 'unrestricted' : 'prompt',
  }).then(
    (answer) => { result(answer, answerOutcome(answer)) },
    (error: unknown) => {
      if (controller.signal.aborted) {
        result({ ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }, 'cancelled')
        return
      }
      fail(error)
    },
  )
}

/**
 * 什么都还没派发之前，先把键盘命令挡下来。
 *
 * 桌面模型照自己策略会做的两种调用，放到键盘命令上就是硬护栏：未知名字没有可校验的调用形状；
 * 关 tab 会毁掉一个用户可能并不是有意指名的东西，所以它要的是那个显式参数，
 * 而不是一个隐含的意图。
 */
function rejectTypedCommand(call: ToolCall): ToolAnswer | undefined {
  if (!BROWSER_TOOL_NAMES.includes(call.name)) {
    const name = call.name.length > 64 ? `${call.name.slice(0, 63)}…` : call.name
    return {
      ok: false,
      error: {
        code: 'bad-args',
        message: `Unknown browser command "${name}". Known commands: ${BROWSER_TOOL_NAMES.join(', ')}.`,
      },
    }
  }
  if (call.name === 'browser_close_tab' && call.args.confirm !== true) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: 'browser_close_tab needs an explicit confirmation: pass {"confirm": true} together with the tabId.',
      },
    }
  }
  return undefined
}

/**
 * 跑一条用户敲进来的 `browser_*` 命令。
 *
 * 跟桌面应用无关：它走的是和模型调用一样的派发路径，但权限按不受限开关给，
 * 所以永远不弹审批提示。参数完全按敲进来的原样用。
 */
async function runTypedCommand(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const call: ToolCall = { id: crypto.randomUUID(), name, args }
  const controller = new AbortController()
  const rejection = rejectTypedCommand(call)
  const summary = activitySummary(call, { ok: true })
  // 这条 pending 行让"这是你要求的"在干活之前就显示出来，同时也是把命令结果镜像到时间线上的
  // 那一行。
  recordActivity({ id: call.id, kind: 'command', name: call.name, summary, origin: null, state: 'pending' })
  let answer: ToolAnswer
  if (rejection !== undefined) {
    answer = rejection
  } else {
    try {
      answer = await executeToolCall({ call, controller, kind: 'command', access: 'unrestricted' })
    } catch (error: unknown) {
      // 派发时抛了异常，也还有调用方在等、有一行要结算；文本与交给模型的那段一样。
      answer = { ok: false, error: { code: 'internal', message: errorText(error) } }
    }
  }
  recordActivity({
    id: call.id,
    kind: 'command',
    name: call.name,
    summary: activitySummary(call, answer),
    origin: null,
    state: answerOutcome(answer),
  })
  return answer
}

function cancelToolCall(id: string): void {
  activeToolCalls.get(id)?.controller.abort()
}

/** 撤销不受限访问前，一次设置写入要等的那些调用。 */
const revocationBarrier = new Set<ActiveToolCall>()

/**
 * 一次调用干完活时结算它。
 *
 * 返回这次调用能不能离开活动 map。撤销期间，调用会一直留在 map 里，直到屏障看到它，
 * 所以一次已经批准的操作还在跑的时候，设置写入绝不可能落盘。
 */
function settleOnCompletion(call: ActiveToolCall): boolean {
  call.settle()
  return !revocationBarrier.has(call)
}

/**
 * bridge 没了，把所有还在路上的工具调用都放弃掉。
 *
 * 每一次调用都要在 map 被清空之前**结算**，这不是可选项：`settled` 正是撤销屏障在等的东西，
 * 不结算就清空 map，`revokeUnrestrictedAccess()` 会永远等下去，安全开关也永远落不了盘。
 * （结算函数是一次性的，所以之后对同一次调用再调 `result()`/`fail()` 没关系。）
 */
function cancelAllToolCalls(): void {
  for (const call of activeToolCalls.values()) {
    call.controller.abort()
    call.settle()
  }
  activeToolCalls.clear()
}

/**
 * 真的把不受限浏览器控制关掉。
 *
 * 全局开关是一道安全边界，关它的时候，绝不能留下一个已经拿到授权、还在对着页面跑的调用。
 * 还没派发页面操作的调用直接取消；已经在路上的操作收不回来，所以设置写入要等它结算完才落盘。
 */
async function revokeUnrestrictedAccess(): Promise<void> {
  const affected = [...activeToolCalls.values()].filter((call) => call.unrestricted)
  for (const call of affected) {
    revocationBarrier.add(call)
    call.controller.abort()
  }
  try {
    await Promise.allSettled(affected.map((call) => call.settled))
  } finally {
    for (const call of affected) {
      revocationBarrier.delete(call)
      for (const [id, candidate] of activeToolCalls) {
        if (candidate === call) activeToolCalls.delete(id)
      }
    }
  }
}

// ---- content script 消息 ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if (sender.id !== chrome.runtime.id) return
  if (sender.tab?.id === undefined) return
  if ((message as { type?: unknown }).type !== 'DSH_CONTENT_READY') return
  // navigation.ts 也在听这个 frame 就绪的宣告；只有这个 listener 会回应，
  // 告诉新文档它已经可以接受操作了。
  sendResponse({ ready: true })
})

// ---- 控制条 port ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTROL_PORT_NAME) return
  controlPorts.add(port)
  armBridgeKeepalive()
  void settingsReady.then(() => {
    // 打开面板，就是用户在说他们打算用这个浏览器，所以这正是从另一个占着槽位的 profile 手里
    // 把 bridge 抢回来的时机。通往面板的每条路都会到这里——工具栏图标、浏览器快捷键、
    // 自动打开——而一个工具栏点击 listener 只覆盖得了其中一条。
    reclaimBridgeIfReplaced()
    if (bridge !== null && bridge.state !== 'stopped') return
    void startBridge()
  })
  try {
    port.postMessage({ type: 'state', state: controlState() })
  } catch {
    // 视图还没渲染第一次就被关掉了。
  }
  for (const request of approvals.pendingRequests()) clearApprovalNotification(request.id)
  syncBadge()
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const request = message as { type?: string }
    switch (request.type) {
      case 'state.request':
        void affinityReady.then(() => {
          try {
            port.postMessage({ type: 'state', state: controlState() })
          } catch {
            // 视图被关掉了。
          }
        })
        break
      case 'settings.update':
        void handleSettingsUpdate(port, message as { id?: unknown; settings?: unknown })
        break
      case 'approval.respond': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'session-trust.clear': {
        if (sessionTrustedActionOrigins.size === 0) break
        sessionTrustedActionOrigins.clear()
        broadcastState()
        break
      }
      case 'bridge.reclaim': {
        // 拨一次号就把槽位认领回来了，所以这里走的和其他重连是同一个入口——
        // `startBridge` 会重启客户端，顺带清掉"被顶替"那个闩锁。每次都全新启动，
        // 用户连按两下按钮也是幂等的。
        void startBridge()
        break
      }
      case 'affinity.respond': {
        const decision = message as { revision?: unknown; decision?: unknown }
        if (typeof decision.revision !== 'number' || !isTabAffinityDecision(decision.decision)) break
        if (!affinity.decide(decision.decision, decision.revision)) break
        persistTabAffinity()
        // "别再问了"是偏好，不是对某一次切换的答复：把等价的模式写进设置，它才能挺过
        // MV3 worker 重启、浏览器重启和下一个对话。`follow` 按设计还要再弹提示，
        // 所以只有 `keep` 会被提升成偏好。这次写入排在任何已经在路上的保存后面，
        // 所以它 fire-and-forget。
        if (decision.decision === 'keep-always' && settings.tabSwitch !== 'keep') {
          void persistSettings({ tabSwitch: 'keep' }, false).catch(() => {})
        }
        broadcastState()
        break
      }
      case 'affinity.rebind': {
        const rebind = message as { id?: unknown }
        if (typeof rebind.id !== 'string') break
        const requestId = rebind.id
        // 截止时间说了算：定时器一边答复控制条，一边中止这次查询，
        // 慢吞吞的 tab 查询绝不可能在用户已经被告知失败之后才动绑定。
        const controller = new AbortController()
        let answered = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const answer = (result: ControlMessage): void => {
          if (answered) return
          answered = true
          if (timer !== undefined) clearTimeout(timer)
          try {
            port.postMessage(result)
          } catch { /* 视图被关掉了 */ }
        }
        timer = setTimeout(() => {
          controller.abort()
          answer({ type: 'affinity.rebind.result', id: requestId, ok: false, error: 'timeout' })
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        void rebindToActiveTab(controller.signal).then(
          () => { answer({ type: 'affinity.rebind.result', id: requestId, ok: true }) },
          (error: unknown) => {
            answer({
              type: 'affinity.rebind.result',
              id: requestId,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )
        break
      }
      case 'session.create': {
        // 页面可能在第一条提示之前就把会话建出来；回复里的 id 是可选的，
        // 因为 id 也会从 `state.session` 过来。
        const create = message as { id?: unknown }
        const requestId = typeof create.id === 'string' ? create.id : ''
        void ensureSession().then(
          (sessionId) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, sessionId }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.prompt': {
        const prompt = message as { id?: unknown; text?: unknown }
        if (typeof prompt.id !== 'string' || typeof prompt.text !== 'string') break
        const requestId = prompt.id
        const text = prompt.text.trim()
        if (text === '') {
          replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: 'The prompt is empty.' })
          break
        }
        void promptSession(text).then(
          (sessionId) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, sessionId }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.cancel': {
        const cancel = message as { id?: unknown }
        if (typeof cancel.id !== 'string') break
        const requestId = cancel.id
        void cancelSession().then(
          (sessionId) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, sessionId }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'command.run': {
        const command = message as { id?: unknown; name?: unknown; args?: unknown }
        if (typeof command.id !== 'string' || typeof command.name !== 'string') break
        const requestId = command.id
        const args = typeof command.args === 'object' && command.args !== null && !Array.isArray(command.args)
          ? command.args as Record<string, unknown>
          : undefined
        if (args === undefined) {
          replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: 'command.run requires an args object.' })
          break
        }
        void runTypedCommand(command.name, args).then(
          (answer) => {
            // 失败文本和交给模型的那段一模一样，所以键盘命令和模型调用之间不会有分歧。
            if (answer.ok) {
              replyToPort(port, { type: 'session.result', id: requestId, ok: true, result: answer.result })
              return
            }
            replyToPort(port, {
              type: 'session.result',
              id: requestId,
              ok: false,
              error: answer.error?.message ?? 'The browser command failed.',
            })
          },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.list': {
        const list = message as { id?: unknown }
        if (typeof list.id !== 'string') break
        const requestId = list.id
        void listSessions().then(
          (sessions) => { replyToPort(port, { type: 'session.list', id: requestId, ok: true, sessions }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.list', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
      case 'session.select': {
        const select = message as { id?: unknown; scope?: unknown; sessionId?: unknown; follow?: unknown }
        if (typeof select.id !== 'string') break
        const requestId = select.id
        const scope: SessionScope = select.scope === 'last'
          ? 'last'
          : select.scope === 'workspace' ? 'workspace' : 'fresh'
        const sessionId = typeof select.sessionId === 'string' && select.sessionId.trim() !== ''
          ? select.sessionId.trim()
          : null
        const follow = select.follow === true
        void selectSessionScope(scope)
          // 等绑定挪好之后再要求跟随，跟的才是面板现在显示的那个对话，而不是上一个。
          // 刻意不在回复前 await：切换本身是已经发生的本地变化，而把确认卡在一次往返之后，
          // 会让慢吞吞的 bridge 看起来像个什么都没做的选择器。
          // `startFollowingSession` 永不 reject。
          .then(() => {
            if (follow && sessionId !== null) void startFollowingSession(sessionId)
          })
          .then(
            () => { replyToPort(port, { type: 'session.result', id: requestId, ok: true }) },
            (error: unknown) => {
              replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
            },
          )
        break
      }
      case 'open.run': {
        const directive = message as { id?: unknown; url?: unknown; pace?: unknown; pin?: unknown }
        if (typeof directive.id !== 'string') break
        const requestId = directive.id
        if (typeof directive.url !== 'string') {
          replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: '@open requires a URL.' })
          break
        }
        const pace = directive.pace === 'fast' || directive.pace === 'slow' ? directive.pace : 'normal'
        void openInFrontOfUser(directive.url, pace, directive.pin !== false).then(
          (result) => { replyToPort(port, { type: 'session.result', id: requestId, ok: true, result }) },
          (error: unknown) => {
            replyToPort(port, { type: 'session.result', id: requestId, ok: false, error: errorText(error) })
          },
        )
        break
      }
    }
  })
  port.onDisconnect.addListener(() => {
    controlPorts.delete(port)
    if (controlPorts.size === 0) {
      // 已经没有可见的视图能作答了，待处理的审批改成发通知。
      approvals.notifyPending()
    }
  })
})

async function handleSettingsUpdate(
  port: chrome.runtime.Port,
  message: { id?: unknown; settings?: unknown },
): Promise<void> {
  const requestId = typeof message.id === 'string' ? message.id : undefined
  const next = typeof message.settings === 'object' && message.settings !== null
    ? message.settings as Partial<Settings>
    : {}
  const reply = (result: ControlMessage): void => {
    try {
      port.postMessage(result)
    } catch {
      // 结果还没送到，视图就被关掉了。
    }
  }
  try {
    await settingsReady
    const previous = { bridgeUrl: settings.bridgeUrl, token: settings.token }
    const revokesUnrestricted = settings.unrestrictedBrowserAccess && next.unrestrictedBrowserAccess === false
    if (revokesUnrestricted) {
      // 撤销是一道屏障，不是翻个标志位：先停掉每个已经拿到授权的调用，再等一个已经派发到
      // 页面的操作结算，然后才把限制性的设置写下去。
      //
      // 内存里的标志*先*清掉，因为屏障可能为一个审批等上两分钟，而 `routeToolCall` 会拿这个
      // 标志给每个新调用盖章。只在 `persistSettings` 内部（await 之后）改它，会让屏障期间
      // 到达的调用照样不经提示就跑——而那正是这道屏障存在要关上的窗口。
      settings.unrestrictedBrowserAccess = false
      await revokeUnrestrictedAccess()
    }
    await persistSettings(next)
    // tab 切换偏好立即生效：拖到下一次切换才生效，会让用户刚在设置里答过的问题
    // 把交接提示继续留在屏幕上。
    if (affinity.setSwitchMode(settings.tabSwitch)) {
      persistTabAffinity()
      // 采用活动 tab 会换掉目标，所以现在就重算一次。
      await syncActiveTab()
    }
    // 只有连接设置才重启 socket。连不连根本不是可选项：装上它就是那个选择，
    // 所以没有哪个开关会跟它失步。
    const connectionChanged = previous.bridgeUrl !== settings.bridgeUrl
      || previous.token !== settings.token
    if (connectionChanged) {
      armBridgeKeepalive()
      await startBridge()
    }
    broadcastState()
    if (requestId !== undefined) reply({ type: 'settings.result', id: requestId, ok: true })
  } catch (error: unknown) {
    if (requestId !== undefined) {
      reply({ type: 'settings.result', id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === ONBOARDING_NOTIFICATION_ID) {
    void Promise.resolve(chrome.notifications.clear(notificationId)).catch(() => {})
    openControlPanel()
    return
  }
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  clearApprovalNotification(notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length))
  // 点通知是扩展层面的用户手势，而侧边面板和侧边栏的打开器要的正是手势。
  openControlPanel()
})

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  if (notificationId === ONBOARDING_NOTIFICATION_ID) {
    void Promise.resolve(chrome.notifications.clear(notificationId)).catch(() => {})
    openControlPanel()
    return
  }
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  openControlPanel()
})

// ---- tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // 等元数据之前先把这次切换标上，一个正在跑的受信任操作就溜不过交接边界。
    observeActiveSummary({ tabId, windowId, title: '', url: '' })
    return chrome.tabs.get(tabId).then((tab) => {
      if (!focusedWindow.isCurrent(activationRevision)) return
      const summary = summarizeTab(tab)
      if (summary !== null) observeActiveSummary(summary)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void affinityReady.then(() => {
    if (!affinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && affinity.observeTab(summary)) broadcastState()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void affinityReady.then(() => {
    // onReplaced 是身份替换（比如 prerender 激活），不是关闭，也不是用户看得见的切换。
    // 同步把这个 id 搬过去，工具解析就永远不会看到已经移除的目标。
    if (!affinity.replaceTab(removedTabId, addedTabId)) return
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastState()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && affinity.observeTab(summary)) broadcastState()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  // 无条件丢掉快照基线：它按 tab id 索引，不丢就会在 worker 的一生里为每个被快照过的 tab
  // 留一条。要在 affinity 检查之前清掉，因为这个 tab 不管是不是受控的那个，都已经没了。
  resetTabSnapshot(tabId)
  void affinityReady.then(() => {
    if (!affinity.removeTab(tabId)) return
    persistTabAffinity()
    broadcastState()
  })
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
})

// ---- keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  if (bridge !== null && bridge.state === 'reconnecting') return
  // 把槽位让给别的浏览器的 bridge 就让它停着：心跳时抢回来，只会让两个开着的 profile
  // 永远互相踢。重新打开控制条、保存地址，或者重启浏览器，才是用户的回头路。
  if (bridge?.wasReplaced === true) return
  void settingsReady.then(() => {
    if (bridge === null || bridge.state === 'stopped') void startBridge()
  })
})

// ---- 启动 ----


settingsReady = loadSettings()
  .then(() => {
    // 会话、最近会话提示、按对话分的 tab，都属于那个已经删掉的侧边面板；
    // 它们的遗留物直接丢掉，不迁移。图片缓存列在这儿是另一个原因：它原本住在 session 存储里，
    // 后来搬去了 `storage.local`，那份 session 副本现在永远不会被读回来。
    return Promise.resolve(chrome.storage.session.remove([
      LEGACY_RECENT_SESSION_STORAGE_KEY,
      'dshSessionContexts',
      IMAGE_CACHE_STORAGE_KEY,
    ])).catch(() => {})
  })
  .then(() => {
    affinityReady = restoreTabAffinity()
    return affinityReady
  })
  // affinity 恢复被拒也绝不能跳过后面的步骤。在这样一条共享链上，这个 rejection 会落到末尾的
  // catch，让缓存空着、也留不下任何原因——失败和它的后果就分不出来了。
  .catch(() => {})
  // 描述和会话状态一起恢复，这样在两次调用之间被停掉的 worker，不必为描述同一张图片再付一次
  // 钱。
  .then(() => restoreImageCache())
  .catch(() => {})

// 扩展一加载就连，没有开关要打开：装上它就是那个选择。先加载设置，
// 这样手输的地址永远不会被自动发现抢先。
void settingsReady.then(() => {
  armBridgeKeepalive()
  void startBridge()
  syncBadge()
})

chrome.runtime.onInstalled.addListener(() => {
  void settingsReady.then(() => { armBridgeKeepalive() })
})
