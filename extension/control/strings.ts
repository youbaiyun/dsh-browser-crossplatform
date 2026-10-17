/**
 * 控制页的双语文案。
 *
 * 中文是主文案，英文必须写全：用这个扩展的人，dsh 界面可能是这两种语言里的
 * 任一种，而只翻了一半的界面读起来就像坏了一样。这里每个字符串都是静态
 * 的；页面和 dsh 给的值由 `main.ts` 用 `textContent` 插进去，绝不经过这份
 * 字典。
 *
 * @module
 */

import type { UiLocale } from '../src/i18n.ts'
import type { OpenError } from './command.ts'

export interface ControlCopy {
  /**
   * 浏览器标签页的标题。
   *
   * 用户在面板上方读到的那个标题**不是**这段代码画的：浏览器拿扩展的
   * manifest 名称渲染侧边栏标题，要改它就得改语言消息文件。这个字段只
   * 管标签页；两者设成同一个完整名称，免得扩展用两种方式介绍自己。这里以前
   * 还有一个 `brand` 字段，对应一个从来没做出来的标题，让人误以为那个标题归我们
   * 改。
   */
  documentTitle: string
  /**
   * 连接状态的措辞。
   *
   * 用 `Record<BridgeState, string>` 加几个额外成员，而不是一个穷尽的 record：
   * 每种连接状态都必须有标签（索引查不到时会回落到 `stopped`），而
   * `replaced`/`reclaim` 描述的是一种并非状态的情况，当成状态会误导人。
   */
  bridge: Record<'connecting' | 'connected' | 'reconnecting' | 'stopped', string> & {
    /** 另一个浏览器占着唯一的 bridge 位置。 */
    replaced: string
    reclaim: string
  }
  tab: {
    none: string
    controlled: string
    handoffTitle: string
    handoffText: string
    keep: string
    follow: string
    keepAlways: string
    lostTitle: string
    lostText: string
    bind: string
    bindFailed: string
  }
  approval: {
    askRead: string
    askAction: string
    unknownOrigin: string
    deny: string
    allowOnce: string
    alwaysAllowReads: string
    trustSession: string
  }
  timeline: {
    request: string
    step: string
    result: string
    tool: string
  }
  plan: {
    title: string
    /** `{done}` 和 `{total}` 会被替换成相应计数。 */
    progress: string
  }
  composer: {
    placeholder: string
    send: string
    sending: string
    stop: string
    openHint: string
    disconnected: string
  }
  /**
   * 用户敲的一条 `@open` 指令为什么用不了。
   *
   * 这些写成函数而不是模板，因为两种语言排列各部分的顺序不同——中文先说规则再
   * 说违规的值，英文先点名值——所以一个靠占位符替换的字符串读起来像翻译过来的，
   * 而不像写出来的。
   *
   * 它们住在这里，不住在解析器旁边，因为选了英文的用户不该收到中文答复。
   * 它们以前正是那副样子：九条硬编码在解析器里的消息，不管面板是什么语言，
   * 每次 `@open` 出错都报中文。
   */
  openError: {
    directiveFormat: (known: string) => string
    unknownDirective: (directive: string, known: string) => string
    missingUrl: (directive: string) => string
    firstArgumentNotUrl: (directive: string, received: string) => string
    notKeyValue: (pair: string) => string
    paceInvalid: (allowed: string, received: string) => string
    pinInvalid: (received: string) => string
    unknownKey: (key: string) => string
    unparsable: string
  }
  settings: {
    heading: string
    /**
     * 设置面板第一行：**连接状态**，只读。
     *
     * 这组键原先叫 `openPages*`，展示的却是连接与否 —— 标签写「允许 AI 打开网页」、
     * 徽章写「已连接/未连接」，还把 `policy !== null`（有没有 policy）当成了连接状态。
     * 两件不同的事挤在一行，读者只能猜。现在这行只讲连接，取名也照它实际表达的东西。
     */
    connection: string
    connectionOn: string
    connectionOff: string
    connectionConnecting: string
    /** 已连接时说什么。 */
    connectionHelp: string
    /** 明确断线（`stopped`）时说什么——与「还没收到 state」是两回事。 */
    connectionOffHelp: string
    connectionUnknown: string
    sharing: string
    sharingAsk: string
    sharingAuto: string
    sharingHelp: string
    tabSwitch: string
    tabSwitchFollow: string
    tabSwitchKeep: string
    tabSwitchAsk: string
    tabSwitchHelp: string
    conversation: string
    conversationFresh: string
    conversationLast: string
    /** 「全部工作区」模式的标签。 */
    conversationWorkspace: string
    conversationHelp: string
    autoOpen: string
    unrestricted: string
    unrestrictedHelp: string
    widthHint: string
    visionTier: string
    visionTierHelp: string
    visionTierOff: string
    visionTierLow: string
    visionTierStandard: string
    visionTierEnhanced: string
  }
  common: {
    reconnecting: string
    reconnectFailed: string
    /** 桌面端以 4002/1008 拒绝握手时说的话，必须点明"用户可以怎么修"。 */
    bridgeRejected: string
    close: string
  }
}

const ZH: ControlCopy = {
  documentTitle: 'dsh 浏览器扩展（全平台）',
  bridge: {
    connecting: '正在连接',
    connected: '已连接',
    reconnecting: '正在重连',
    stopped: '未连接',
    replaced: '连接被另一个浏览器窗口接管了。要在这个窗口用，点下面取回来；不用那个窗口的话，建议把它的扩展关掉。',
    reclaim: '取回连接',
  },
  tab: {
    none: '未选择页面',
    controlled: 'AI 正在操作的页面',
    handoffTitle: '你换了标签页',
    handoffText: 'AI 已暂停。留在原来的页面，还是跟着你换过去？',
    keep: '留在原页面',
    follow: '跟过去',
    keepAlways: '留在这里，不再问',
    lostTitle: '操作的页面被关闭了',
    // 这里点名唯一存在的那个动作。“Pick a page” 暗示有得选，但这个按钮绑定
    // 的就是你已经在的那个标签页——所以这句话先说要去切页，再由它下面那个按钮
    // 完成绑定。
    lostText: 'AI 已暂停，不会自作主张换页面。想让它继续，就切到你希望它操作的页面，再点下面的按钮绑定；不管它也行。',
    bind: '用我现在这个页面',
    bindFailed: '无法接管这个页面',
  },
  approval: {
    askRead: 'AI 想读取这个页面',
    askAction: 'AI 想操作这个页面',
    unknownOrigin: '未知网站',
    deny: '不允许',
    allowOnce: '允许',
    alwaysAllowReads: '以后读取不用问',
    trustSession: '这个网站以后不用问',
  },
  timeline: {
    request: '你的指令',
    step: '步骤',
    result: '结果',
    tool: '工具',
  },
  plan: {
    title: '任务表',
    progress: '{done}/{total} 已完成',
  },
  composer: {
    placeholder: '输入要做什么',
    send: '发送',
    sending: '发送中',
    stop: '停止',
    openHint: '@open 网页地址（可加 pace=slow 让它慢一点、pin=off 不接管页面）',
    disconnected: '还没连上桌面端 —— 要先打开 dsh 才会开始连接；只打开浏览器是连不上的，打开 dsh 后重新打开这个侧边栏即可',
  },
  openError: {
    directiveFormat: (known) => `指令格式：${known} <网址> [pace=…] [pin=…]`,
    unknownDirective: (directive, known) => `未知指令 @${directive}，可用：${known}`,
    missingUrl: (directive) => `@${directive} 缺少网址，例如：@${directive} https://example.com`,
    firstArgumentNotUrl: (directive, received) =>
      `@${directive} 的第一个参数必须是网址（http/https 或域名），收到：${received}`,
    notKeyValue: (pair) => `参数要写成 key=value，无法识别：${pair}`,
    paceInvalid: (allowed, received) => `pace 只能是 ${allowed}，收到：${received}`,
    pinInvalid: (received) => `pin 只能是 on / off，收到：${received}`,
    unknownKey: (key) => `未知参数：${key}（可用：pace、pin）`,
    unparsable: '指令无法解析',
  },
  settings: {
    heading: '更改设置',
    connection: 'dsh 连接状态',
    connectionOn: '已连接',
    connectionOff: '未连接',
    connectionConnecting: '正在连接',
    connectionHelp: '要先打开 dsh 才会开始连接；只打开浏览器是连不上的。连上之后，桌面端就能读你正在看的那一页。',
    connectionOffHelp: '没连上 dsh。要先打开 dsh 才会开始连接——只打开浏览器连不上；启动 dsh 后重新打开侧边栏即可。',
    connectionUnknown: '还没连上桌面端。要先打开 dsh 才会开始连接——只打开浏览器连不上；启动 dsh 后重新打开侧边栏即可。',
    sharing: 'AI 读取权限',
    sharingAsk: '每次询问',
    sharingAuto: '直接读取',
    sharingHelp: '每次询问：AI 读取网页和执行操作时都会询问\n直接读取：AI 在读取和执行操作时都不再询问你',
    tabSwitch: 'AI 跟随网页',
    tabSwitchFollow: '跟随',
    tabSwitchKeep: '留在原页面',
    tabSwitchAsk: '每次询问',
    tabSwitchHelp: 'AI 就像人一样：你打开新的页面时，AI 能不能看见你新开的网页。默认「跟随」，不再询问。',
    conversation: '对话同步',
    conversationFresh: '工作区内新建对话',
    conversationLast: '工作区内上次浏览器对话',
    conversationWorkspace: '全部工作区',
    conversationHelp: '你在浏览器插件中的对话，发到桌面端哪段对话位置。三档都局限在「浏览器对话」这个工作区内。\n工作区内新建对话：重新在浏览器插件里对话时，会在「浏览器对话」工作区里新建一个对话。\n工作区内上次浏览器对话：继续上次在「浏览器对话」工作区里的那段对话。\n全部工作区：不管你从哪个工作区发出对话，都同步到浏览器插件里。',
    autoOpen: '打开浏览器时是否自动打开插件侧边栏',
    unrestricted: '不再询问，直接操作',
    unrestrictedHelp: '读网页、点按钮、关标签页，都不再问你。不确定它在做什么就别开。',
    widthHint: '宽度由浏览器决定，拖左边缘调整，Chrome 会记住。',
    visionTier: '看图',
    visionTierHelp: '建议不开：看一张图要多花约一秒，图会离开这台机器发给你配置的模型；关着就完全不读图。开了就是让模型看图——低档说图里有什么，标准档再和页面文字对一下，增强档再问它在页里干什么。同一张图问过一次就不再重复请求，记 24 小时。',
    visionTierOff: '关',
    visionTierLow: '低',
    visionTierStandard: '标准',
    visionTierEnhanced: '增强',
  },
  common: {
    reconnecting: '正在重连后台',
    reconnectFailed: '后台连接已断开，请重新加载页面',
    bridgeRejected: '桌面端拒绝了这次连接：令牌或扩展 id 对不上。如果你手动加载的是文件名带「-store」的包，请改用不带「-store」的那个（它带 key，id 才在白名单里）；否则请检查扩展的 token 设置。',
    close: '关闭',
  },
}

const EN: ControlCopy = {
  // 英文没有对应的括注要镜像：商店名本身就是同一个词组，所以这里的短名称和
  // 完整名称在这里是一样的。
  documentTitle: 'dsh Browser Extension',
  bridge: {
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    stopped: 'Not connected',
    replaced: 'Another browser window took over the connection. Take it back with the button below, or turn that window\'s extension off if you are not using it.',
    reclaim: 'Take it back',
  },
  tab: {
    none: 'No page selected',
    controlled: 'The page the AI is using',
    handoffTitle: 'You switched tabs',
    handoffText: 'The AI has paused. Stay on the original page, or follow you to this one?',
    keep: 'Stay on the page',
    follow: 'Follow me',
    keepAlways: 'Stay here, stop asking',
    lostTitle: 'The page being used was closed',
    lostText: 'The AI has paused and will not pick a page on its own. To continue, switch to the page you want it to use, then press the button below to bind it — or leave it for now.',
    bind: 'Use the page I am on',
    bindFailed: 'Could not take over this page',
  },
  approval: {
    askRead: 'Wants to read this page',
    askAction: 'Wants to change this page',
    unknownOrigin: 'Unknown website',
    deny: 'Don\'t allow',
    allowOnce: 'Allow',
    alwaysAllowReads: 'Never ask about reading',
    trustSession: 'Never ask about this website',
  },
  timeline: {
    request: 'Your instruction',
    step: 'Step',
    result: 'Result',
    tool: 'Tool',
  },
  plan: {
    title: 'Task list',
    progress: '{done}/{total} done',
  },
  composer: {
    placeholder: 'What should happen?',
    send: 'Send',
    sending: 'Sending',
    stop: 'Stop',
    openHint: '@open <url> [pace=fast|normal|slow] [pin=on|off] — the extension opens it so you can watch',
    disconnected: 'Not connected — dsh has to be running first: opening the browser alone cannot connect. Start dsh, then reopen this panel.',
  },
  openError: {
    directiveFormat: (known) => `Format: ${known} <url> [pace=…] [pin=…]`,
    unknownDirective: (directive, known) => `Unknown directive @${directive}. Available: ${known}`,
    missingUrl: (directive) => `@${directive} needs a URL, for example: @${directive} https://example.com`,
    firstArgumentNotUrl: (directive, received) =>
      `The first @${directive} argument must be a URL (http/https or a domain); got: ${received}`,
    notKeyValue: (pair) => `Options are written key=value; could not read: ${pair}`,
    paceInvalid: (allowed, received) => `pace must be one of ${allowed}; got: ${received}`,
    pinInvalid: (received) => `pin must be on or off; got: ${received}`,
    unknownKey: (key) => `Unknown option: ${key}. Available: pace, pin`,
    unparsable: 'The directive could not be parsed',
  },
  settings: {
    heading: 'Change settings',
    connection: 'dsh connection status',
    connectionOn: 'Connected',
    connectionOff: 'Not connected',
    connectionConnecting: 'Connecting',
    connectionHelp: 'dsh has to be running first — opening the browser alone cannot connect. Once connected, the desktop can read the page you are looking at.',
    connectionOffHelp: 'Not connected to dsh. dsh has to be running first — opening the browser alone cannot connect; start dsh, then reopen this panel.',
    connectionUnknown: 'Not connected to dsh yet. dsh has to be running first — opening the browser alone cannot connect; start dsh, then reopen this panel.',
    sharing: 'AI read permission',
    sharingAsk: 'Ask every time',
    sharingAuto: 'Read directly',
    sharingHelp: 'Ask every time: the AI asks before reading the page and before acting\nRead directly: the AI asks neither before reading nor before acting',
    tabSwitch: 'AI follows new pages',
    tabSwitchFollow: 'Follow',
    tabSwitchKeep: 'Stay on the page',
    tabSwitchAsk: 'Ask me',
    tabSwitchHelp: 'The AI is like a person here: when you open a new page, can it see the page you just opened? It follows by default, without asking.',
    conversation: 'Chat sync',
    conversationFresh: 'New chat in the workspace',
    conversationLast: 'Last browser chat in the workspace',
    conversationWorkspace: 'All workspaces',
    conversationHelp: 'Which desktop chat receives what you type in the browser panel. The first two stay inside the desktop workspace the extension uses for browsing.\nNew chat in the workspace: talking in the extension again starts a new chat in that workspace.\nLast browser chat in the workspace: continues the chat you last used in that workspace.\nAll workspaces: whichever workspace you send from, it syncs into the extension.',
    autoOpen: 'Open the side panel automatically when the browser is used',
    unrestricted: 'Stop asking and just act',
    unrestrictedHelp: 'Reading pages, clicking buttons and closing tabs all happen without asking you. Do not turn this on unless you know what it is doing.',
    widthHint: 'The browser decides the width; drag the left edge, and Chrome remembers it.',
    visionTier: 'Look at images',
    visionTierHelp: 'Off means no image is ever looked at, and none leaves this machine. Turning it on costs about a second per new image: that image leaves this machine for the model you configured. Low only says what is in the picture. Standard also checks it against the words on your page and warns you when the two disagree. Enhanced additionally asks what the image is doing on the page. An image you already asked about is answered from a 24-hour memo instead of being looked at again.',
    visionTierOff: 'Off',
    visionTierLow: 'Low',
    visionTierStandard: 'Standard',
    visionTierEnhanced: 'Enhanced',
  },
  common: {
    reconnecting: 'Reconnecting to the background',
    reconnectFailed: 'The background connection is gone; reload this panel',
    bridgeRejected: 'The desktop app rejected this connection: the token or the extension id does not match. If you side-loaded an archive whose name contains "-store", use the one without it instead — only that build carries the manifest key whose id is on the allowlist. Otherwise check the extension\'s token setting.',
    close: 'Close',
  },
}

export function controlCopy(locale: UiLocale): ControlCopy {
  return locale === 'zh' ? ZH : EN
}

/**
 * 把指令解析失败变成用户读得懂的一句话。
 *
 * 解析器报的是原因而不是消息，因为它没有 locale，也因为一个自己拼用户可见
 * 句子的模块没法被别处复用。这里是唯一决定原因该怎么措辞的地方。
 *
 * 未知的 `kind` 回落到通用消息，不抛错：更新的后台构建可能发来一个这个
 * 面板还没学会的原因，而为了解释一个笔误换来空白面板不值得。
 */
export function describeOpenError(locale: UiLocale, error: OpenError): string {
  const copy = controlCopy(locale).openError
  switch (error.kind) {
    case 'directiveFormat': return copy.directiveFormat(error.known)
    case 'unknownDirective': return copy.unknownDirective(error.directive, error.known)
    case 'missingUrl': return copy.missingUrl(error.directive)
    case 'firstArgumentNotUrl': return copy.firstArgumentNotUrl(error.directive, error.received)
    case 'notKeyValue': return copy.notKeyValue(error.pair)
    case 'paceInvalid': return copy.paceInvalid(error.allowed, error.received)
    case 'pinInvalid': return copy.pinInvalid(error.received)
    case 'unknownKey': return copy.unknownKey(error.key)
    default: return copy.unparsable
  }
}
