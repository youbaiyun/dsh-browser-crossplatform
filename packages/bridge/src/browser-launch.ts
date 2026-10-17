/**
 * 启动用户的浏览器，好让扩展加载进来。
 *
 * 其它浏览器工具全都在扩展里跑，所以它们都需要有一个已经开着的浏览器——而在此之前
 * bridge 对此无能为力。浏览器关着就没有扩展可连，这些工具于是统统以 `bridge-closed`
 * 失败，用户卡在原地：“浏览器没开”只能靠把浏览器开起来解决，桌面这一侧什么都做不了。
 *
 * 这个设计建立在两条事实上，它们都是在这台机器上对着浏览器实测出来的，不是猜的：
 *
 * 1. **浏览器已经在跑时，这次启动会被忽略。** Chrome 已经起来后再把标志交给
 *    `chrome.exe`，只会在已有进程里开个窗口，标志被丢掉。所以浏览器本来就在运行时，
 *    我们就如实说，而不是假装启动了什么。
 * 2. **扩展塞不进别人的 profile。** 从 Chrome 137 起，品牌版 Chrome 构建彻底移除了
 *    `--load-extension`（Chromium 和 Chrome for Testing 还收），而且就算它还能用，
 *    也只在这一会话里有效——它并没有被装上。所以真正有用的启动是普通启动，进入那个
 *    扩展*已经*装好的 profile：后台 worker 会自己回来连上。
 *
 * 老实说：第一次得用户自己装扩展（从商店装，或者“加载已解压的扩展程序”
 * （load unpacked）走一遍）。之后普通启动就够了，本模块把这一步自动化。它不会——也
 * 不可能——替用户装扩展，所以它从不说自己装上了。
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 一个候选可执行文件，以及这个路径的出处。 */
export interface BrowserCandidate {
  /** 消息里用的简短 id（`chrome`、`edge`、`brave`、`chromium`、`firefox`）。 */
  id: string
  /** 绝对路径或裸命令名。 */
  path: string
  /** 路径存在时为 true（裸命令名交给操作系统解析）。 */
  exists: boolean
}

/**
 * 启动器需要的全部输入，由插件配置解析而来。
 *
 * 路径都可以注入，这样整个决策面都能进单元测试：不用真的启动进程，也不要求机器上
 * 装了浏览器。
 */
export interface LaunchDeps {
  /** 显式指定的可执行文件；一旦设置就完全跳过探测。 */
  executablePath?: string
  /**
   * 要加载的未打包扩展目录。只有它确实躺在磁盘上才会用——传一个过期的路径，Chrome
   * 会拒绝整次启动。
   */
  extensionPath?: string
  /**
   * 仅 Chrome/Chromium：浏览器复用会话所在的那个 profile 目录。137+ 上
   * `--load-extension` 要生效就得有它。
   */
  userDataDir?: string
  /** 原样追加的额外命令行参数。 */
  extraArgs?: readonly string[]
  /**
   * 不带可见窗口启动。e2e 套件以及任何在没有显示器的机器上驱动 bridge 的人会用它；
   * 普通启动不会打开它。
   */
  headless?: boolean
  /** 等待扩展连上来的时长；默认 25 秒。 */
  timeoutMs?: number
  /** 为测试注入。 */
  exists?: (path: string) => boolean
  /** 为测试注入。 */
  spawnDetached?: (command: string, args: readonly string[]) => void
  /** 为测试注入：`probeRunningBrowsers` 所读取的进程列表。 */
  processListing?: (platform: NodeJS.Platform) => Promise<{ name: string; commandLine: string }[] | undefined>
  /**
   * 为测试注入：用户*默认*浏览器的可执行文件。
   *
   * 它优先于自动探测：用户想驱动的本来就是他正在用的那个浏览器，换个 Chromium 就等于
   * 换个 profile，里面没有他的任何 session；平台不记录这项时返回 undefined。
   */
  executableOfDefaultBrowser?: (platform: NodeJS.Platform) => string | undefined
  /**
   * 为测试注入：哪些浏览器已经装了这个扩展，以及看过哪些 profile。
   *
   * 它决定这次启动有没有可能成功，也让消息说出实情（“在我们能读到的 profile 里它没
   * 装”），而不是给一堆帮不上忙的步骤。
   */
  extensionInstall?: (platform: NodeJS.Platform) => ExtensionInstallScan
  /**
   * 为测试注入：某个目录里的条目；读不到时为 undefined。
   *
   * profile 目录归浏览器自己管，不是一张固定列表——多出第四个 profile，`Profile 4+`
   * 就存在了——所以这里靠枚举。
   */
  listDirectory?: (path: string) => string[] | undefined
  /** 为测试注入。 */
  waitForConnection?: (timeoutMs: number) => Promise<boolean>
  /**
   * 为测试注入：浏览器是不是已经在运行、用的是哪个 profile。正因为有这项探测，bridge
   * 才不会去“启动”一个本来就开着的浏览器（对已在运行的实例，那其实什么都没做）。
   */
  probeRunning?: (candidates: readonly BrowserCandidate[], wantedUserDataDir: string | undefined) => Promise<RunningBrowser[]>
  /** 为测试注入；默认取真实平台。 */
  platform?: NodeJS.Platform
  /** 为测试注入；默认取 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /**
   * 为测试注入：正在运行的浏览器有没有可见窗口。
   *
   * Chromium 进程比它的窗口活得久——关掉最后一个窗口，进程可能还驻留，扩展的 socket
   * 也还开着——所以“已连接”和“有一个能操作的窗口”是两回事。只有明确的 `false` 才会
   * 被拿来行动；`undefined` 表示这个平台问不出来。
   */
  visibleWindow?: (candidates: readonly BrowserCandidate[]) => Promise<boolean | undefined>
}

/** 一次探测所能断定的、还活着的浏览器进程。 */
export interface RunningBrowser {
  /** 探测到的 id（`chrome`、`edge`、…）；不匹配任何已知路径时为 `other`。 */
  id: string
  /** `--user-data-dir` 的值；使用平台默认 profile 时为 `''`。 */
  userDataDir: string
}

/** 一次启动尝试的最终结果，工具拿它当返回值。 */
export interface LaunchOutcome {
  /** 是否真的启动了一个浏览器进程。 */
  launched: boolean
  /** 是否找到并选中了一个本次启动可用的浏览器。 */
  resolved: boolean
  connected: boolean
  /** 人和模型都能读的摘要，永不为空。 */
  message: string
  /**
   * 必须去那个页面动手时，所涉浏览器的扩展页面。
   *
   * 它只在一种时候出现：bridge 能看到的所有 profile 里都没装这个扩展——也就是没有自动
   * 出路的情形。带上地址，模型和用户就不必自己琢磨该打开哪个页面；只丢一句“去安装
   * 它”却不给去处，正是这里要避免的死胡同。
   */
  installUrl?: string
}

/** 浏览器用来加载或启用扩展的那个页面。 */
export function extensionsPageUrl(browserId: string): string {
  if (browserId === 'edge') return 'edge://extensions/'
  // Chromium、Brave 和 Chrome 都用 Chrome 的 scheme。
  return 'chrome://extensions/'
}

/**
 * 本扩展安装后用的目录名，用来检查某个 profile 里装了没有。
 *
 * 它是 `DEFAULT_EXTENSION_IDS` 的一份副本：本模块不能 import 插件入口（会形成循环），
 * 而 `tests/extension-identity.spec.ts` 断言两者一致。两个 id 在这里都重要，因为同一个
 * 构建有两个名字——开发加载被 manifest 的 `key` 钉死，商店拒绝这个 key 并自己分配一个，
 * 安装就落在另一个目录名下。只探测第一个——这里原先就是这么做的——每一次商店安装都会被
 * 读成“哪儿都没装”，用户于是被引上只有开发者才走得通的那条路。
 */
export const EXTENSION_DIRECTORY_NAMES: readonly string[] = [
  'kdhkdgfcinfkmogifamoapmheihhcjfk',
  'agpipnjijkpomaannkijkilggoffdiaf',
]

/**
 * 读不到浏览器自己的目录列表时，退回来探测这几个 profile。
 *
 * 每个 Chromium 浏览器都有这些，所以枚举不可用时它们是个有用的子集——空列表会什么都
 * 不检查，然后对一台 profile 从没看过的浏览器报“没有安装”。
 */
const FALLBACK_PROFILE_NAMES = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'] as const

const DEFAULT_LAUNCH_TIMEOUT_MS = 25_000

/** 仅对绝对的 `http:`/`https:` URL 为 true。 */
export function isWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 要去打开的网址（已去除首尾空白）；不是网址时为 undefined。 */
export function webUrlOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed !== '' && isWebUrl(trimmed) ? trimmed : undefined
}

/**
 * 一次启动用的参数。
 *
 * 启动用户自己的浏览器就是一次*普通*启动：只给可执行文件，别的什么都不给。不带
 * `--user-data-dir`（那会换到另一个 profile——在用户看来就是另一个浏览器，没有他的
 * 标签页和登录），也不带 `--load-extension`（未打包加载只撑一个会话、什么都不安装，
 * 而且从 Chrome 137 起品牌版构建根本不理会它）。
 *
 * 这些标志只在一种情形下真有用：启动进调用方指定的 profile，开发和测试构建就是这么
 * 起来的。所以除非设了 `userDataDir`，`extensionPath` 一律忽略。
 *
 * @param deps - 扩展目录、profile、额外参数、无头。
 * @param url - 要打开的页面；省掉它，浏览器就打开自己的新标签页。
 * @returns 参数列表。
 */
export function buildLaunchArgs(
  deps: Pick<LaunchDeps, 'extensionPath' | 'userDataDir' | 'extraArgs' | 'headless'>,
  url?: string,
): string[] {
  const args: string[] = []
  const namedProfile = deps.userDataDir !== undefined && deps.userDataDir !== ''
  if (namedProfile) {
    args.push(`--user-data-dir=${deps.userDataDir ?? ''}`)
  }
  // 未打包加载只在指定的 profile 里才有意义。
  const loadingExtension = namedProfile && deps.extensionPath !== undefined && deps.extensionPath !== ''
  if (loadingExtension) {
    // Chromium 原样接受这个标志；品牌版 Chrome 构建无论如何都会忽略它，所以这只对
    // Chromium/Chrome for Testing 的 profile 有意义。
    args.push('--disable-features=DisableLoadExtensionCommandLineSwitch')
    args.push(`--load-extension=${deps.extensionPath ?? ''}`)
    args.push(`--disable-extensions-except=${deps.extensionPath ?? ''}`)
  }
  if (deps.headless === true) {
    // `new` 是仍会运行扩展的那个模式；旧模式不会。
    args.push('--headless=new')
  }
  // URL 会变成*命令行参数*，所以这里就得按参数来对待：只放行真正的 http/https 地址，
  // 否则调用方传进来的 `--headless` 这类字符串会被浏览器当成开关读，而不是当成页面。
  // 没有 URL，就意味着让浏览器打开它平时打开的东西——新标签页，或者恢复的会话——
  // 这个位置永远不会被塞进占位值。
  if (url !== undefined && url !== '' && isWebUrl(url)) args.push(url)
  for (const extra of deps.extraArgs ?? []) args.push(extra)
  return args
}

/** 各平台众所周知的安装位置，最常见的在前。 */
export function browserCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { chrome: string[]; edge: string[]; brave: string[]; chromium: string[]; firefox: string[] } {
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env['LOCALAPPDATA'] ?? ''
    return {
      chrome: [
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ...(localAppData === '' ? [] : [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
      ],
      edge: [
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
      brave: [
        join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ...(localAppData === '' ? [] : [join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]),
      ],
      chromium: [
        ...(localAppData === '' ? [] : [join(localAppData, 'Chromium', 'Application', 'chrome.exe')]),
      ],
      firefox: [
        join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
        join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      firefox: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    }
  }
  return {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chrome'],
    edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    brave: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    firefox: ['/usr/bin/firefox', '/snap/bin/firefox'],
  }
}

/** 检测顺序：Chromium 系浏览器在前，Firefox（没有侧边栏）在最后。 */
const DETECTION_ORDER = ['chrome', 'edge', 'brave', 'chromium', 'firefox'] as const

/**
 * 各平台的浏览器把 profile 根目录放在哪。
 *
 * 用来回答那个唯一决定“启动浏览器有没有用”的问题：这个扩展到底装在它里面没有？
 * 启动本身装不了扩展。
 */
export function userDataRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Record<string, string> {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] ?? ''
    return {
      chrome: windowsPath(local, 'Google', 'Chrome', 'User Data'),
      edge: windowsPath(local, 'Microsoft', 'Edge', 'User Data'),
      brave: windowsPath(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      chromium: windowsPath(local, 'Chromium', 'User Data'),
      firefox: windowsPath(env['APPDATA'] ?? '', 'Mozilla', 'Firefox', 'Profiles'),
    }
  }
  if (platform === 'darwin') {
    return {
      chrome: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Google', 'Chrome'),
      edge: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Microsoft Edge'),
      brave: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
      chromium: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Chromium'),
      firefox: posixPath(env['HOME'] ?? '', 'Library', 'Application Support', 'Firefox', 'Profiles'),
    }
  }
  const config = env['XDG_CONFIG_HOME'] ?? posixPath(env['HOME'] ?? '', '.config')
  return {
    chrome: posixPath(config, 'google-chrome'),
    edge: posixPath(config, 'microsoft-edge'),
    brave: posixPath(config, 'BraveSoftware', 'Brave-Browser'),
    chromium: posixPath(config, 'chromium'),
    firefox: posixPath(env['HOME'] ?? '', '.mozilla', 'firefox'),
  }
}

/**
 * 拼出一个带反斜杠的 Windows profile 路径，不管在哪个平台上拼。
 *
 * `join` 用的是宿主的分隔符，那样 Windows 路径长什么样就取决于测试恰好在哪台机器上跑。
 * 这些路径始终要和 Windows 风格的值比较，所以一律按 Windows 风格拼。
 */
function windowsPath(root: string, ...parts: string[]): string {
  if (root === '') return ''
  return [root, ...parts].join('\\')
}

/**
 * 拼出一个带正斜杠的 POSIX profile 路径，不管在哪个平台上拼。
 *
 * 理由和 {@link windowsPath} 一样：用宿主的分隔符，会让 macOS 或 Linux 的路径长什么样
 * 随调用方在哪跑而变。
 */
function posixPath(root: string, ...parts: string[]): string {
  if (root === '') return ''
  return [root.replace(/\/+$/u, ''), ...parts].join('/')
}

/** 这轮扩展检查查到了什么，以及在哪些地方查的。 */
export interface ExtensionInstallScan {
  /** 至少有一个 profile 装了该扩展的浏览器 id。 */
  installed: string[]
  /**
   * 每个读过 profile 的浏览器一个 `<browserId> (<profiles>)` 标签。
   *
   * 之所以把它带出扫描结果，是因为“没有安装”那句话曾经断言本机任何浏览器 profile 里
   * 都没有，而检查其实只在一个扩展 id 下读了四个固定的目录名。把这些名字写出来，那句
   * 话就不会超出真正看过的范围。
   */
  checked: string[]
}

/**
 * Chromium 系浏览器手里真正有的 profile 目录，`Default` 在最前。
 *
 * 靠枚举，不靠假定：这里换掉的那张固定列表止于 `Profile 3`，装在 `Profile 4` 或更靠后
 * 的扩展就被报成到处都没有。只认两种真实存在的 profile 形态——user-data 根目录下还放着
 * `Local State` 这类文件——带编号的按数值排序，因为按文本比 `Profile 10` 会排在
 * `Profile 2` 前面。
 *
 * 列表读不到时，返回每个浏览器都有的那几个名字，而不是什么都不返回：读不了的目录
 * 绝不能变成“什么都没检查，所以它没装”。
 */
function chromiumProfileNames(root: string, listDirectory: (path: string) => string[] | undefined): string[] {
  const entries = listDirectory(root)
  if (entries === undefined) return [...FALLBACK_PROFILE_NAMES]
  const numbered: number[] = []
  for (const entry of entries) {
    const match = /^Profile (\d+)$/u.exec(entry)
    if (match !== null) numbered.push(Number(match[1]))
  }
  numbered.sort((left, right) => left - right)
  const profiles = entries.includes('Default')
    ? ['Default', ...numbered.map((value) => `Profile ${value}`)]
    : numbered.map((value) => `Profile ${value}`)
  return profiles.length > 0 ? profiles : [...FALLBACK_PROFILE_NAMES]
}

/**
 * 一个目录里的条目名；读不到时是 undefined。
 *
 * 这里用 `undefined` 而不是空列表，是因为调用方需要这个区分：空列表意味着“这个根目录下
 * 没有 profile”，那会什么都不检查；而读不到的根目录必须退回那几个始终存在的名字。
 */
function readDirectoryNames(path: string): string[] | undefined {
  try {
    return readdirSync(path)
  } catch {
    return undefined
  }
}

/**
 * 某个浏览器 profile 里装了扩展没有，以及看过哪些 profile。
 *
 * 装扩展是用户的动作——从商店装，或者“加载已解压的扩展程序”走一遍——没有任何命令行
 * 标志能代替它；未打包加载只撑一个会话，下次启动就没了（已验证）。所以这里回答的是
 * 决定一次启动成败的那个问题，并让 bridge 说出用户实际是哪一种情形，而不是去猜。
 *
 * @param platform - 目标平台。
 * @param env - 环境变量，用来定位上面那些 profile 根目录。
 * @param extensions - 扩展的目录名，它可能有的每个 id 各一个。
 * @param exists - 文件系统探测，测试注入。
 * @param listDirectory - 目录列表，测试注入。
 * @returns 装了它的浏览器，以及每个浏览器读了哪些 profile。
 */
export function scanExtensionInstalls(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  extensions: readonly string[],
  exists: (path: string) => boolean = existsSync,
  listDirectory: (path: string) => string[] | undefined = readDirectoryNames,
): ExtensionInstallScan {
  const installed: string[] = []
  const checked: string[] = []
  const ids = extensions.filter((id) => id !== '')
  if (ids.length === 0) return { installed, checked }
  const roots = userDataRoots(platform, env)
  // 按目标平台的分隔符拼，不用宿主的：这些值要和浏览器自己给出的路径比较。
  const under = (root: string, ...parts: string[]): string => platform === 'win32'
    ? windowsPath(root, ...parts)
    : posixPath(root, ...parts)
  for (const id of DETECTION_ORDER) {
    const root = roots[id]
    if (root === undefined || root === '') continue
    const profiles = chromiumProfileNames(root, listDirectory)
    checked.push(`${id} (${profiles.join(', ')})`)
    const found = profiles.some((profile) => ids.some((extension) => exists(under(root, profile, 'Extensions', extension))))
    if (found) installed.push(id)
  }
  return { installed, checked }
}

/**
 * profile 里装了该扩展的浏览器 id，就这些。
 *
 * 完整答案在上面那次扫描里；这里的形态是给那些只关心“这次启动到底能不能成”的调用方
 * 用的。
 *
 * @param platform - 目标平台。
 * @param env - 环境变量，用来定位上面那些 profile 根目录。
 * @param extensions - 扩展的目录名；为 undefined 时跳过。
 * @param exists - 文件系统探测，测试注入。
 * @returns profile 里装了该扩展的浏览器 id。
 */
export function browsersWithExtensionInstalled(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  extensions: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (extensions === undefined || extensions === '') return []
  return scanExtensionInstalls(platform, env, [extensions], exists).installed
}

/**
 * 平台记录了用户默认浏览器的可执行文件时，把它返回。
 *
 * 用户要驱动的是*他们自己的*浏览器，所以这优先于检测到的第一个安装：启动另一个
 * Chromium，等于换成一个他们不用的浏览器，里面也没有他们的任何会话。Windows 和 macOS
 * 都记录了这个选择；Linux 只用 `xdg-settings` 暴露它，而那不是文件，所以交给调用方
 * 回退，不在这里猜。
 *
 * @param platform - 目标平台。
 * @param readDefault - 返回记录下来的命令或 app bundle id。
 * @param exists - 文件系统探测，测试注入。
 * @returns 绝对可执行文件路径；无法解析时为 undefined。
 */
export function defaultBrowserExecutable(
  platform: NodeJS.Platform,
  readDefault: () => string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const recorded = readDefault()
  if (recorded === undefined || recorded === '') return undefined
  if (platform === 'darwin') {
    // LaunchServices 报出来的是 `com.google.Chrome` 这样的 bundle id；这里只映射承载
    // 本扩展宿主浏览器的两个，碰上不认识的 bundle id 就退回检测，不猜。
    // Windows 记录的是 `"C:\...\chrome.exe" --single-argument %1` 这样的命令行。
    const bundles: Record<string, string> = {
      'com.google.chrome': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'com.microsoft.edgemac': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'org.chromium.chromium': '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'com.brave.browser': '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    }
    const path = bundles[recorded.toLowerCase()]
    return path !== undefined && exists(path) ? path : undefined
  }
  /** Windows 上指定默认浏览器的注册表值。 */
  const quoted = /^"([^"]+)"/u.exec(recorded)
  const first = quoted?.[1] ?? recorded.split(' ')[0]
  if (first === undefined || first === '') return undefined
  return exists(first) ? first : undefined
}

// 这里故意用同步：这段代码只跑一次，而且是在用户正等着的一次启动里。
function readWindowsDefaultBrowser(): string | undefined {
  try {
    // ProgId 指定的是处理器，不是路径；路径在它的 shell\open\command 里。
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const key = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice'
    const output = execFileSync('reg', ['query', key, '/v', 'ProgId'], { encoding: 'utf8', windowsHide: true })
    const match = /ProgId\s+REG_SZ\s+(\S+)/u.exec(output)
    const progId = match?.[1]
    if (progId === undefined) return undefined
    /**
 * macOS 上默认浏览器的 bundle id。
 *
 * LaunchServices 把用户的选择记在用户偏好设置里；它返回的 bundle id 由
 * {@link defaultBrowserExecutable} 映射成 app 路径。读偏好设置只是尽力而为——严格管控
 * 或刚装好的机器上可能没这个键——拿不到答案就顺势退回检测。
 */
    const command = execFileSync('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], { encoding: 'utf8', windowsHide: true })
    const commandMatch = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/u.exec(command)
    return commandMatch?.[1]?.trim()
  } catch {
    return undefined
  }
}

// 公开 http 方案下，第一个处理器就是响应链接的那个。
function readMacDefaultBrowser(): string | undefined {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const plist = execFileSync('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    /** 平台自己记的“哪个浏览器负责打开链接”，前提是它有这项记录。 */
    const httpScheme = /LSHandlerURLScheme\s*=\s*"?https?"?;[\s\S]{0,400}?LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/u.exec(plist)
    return httpScheme?.[1]
  } catch {
    return undefined
  }
}

/**
 * 每个候选都带上 `exists` 标志，按检测顺序排。
 *
 * @param platform - 目标平台。
 * @param env - 该平台各安装根目录需要的环境变量。
 * @param exists - 文件系统探测，测试注入。
 * @returns 未过滤的候选列表，调用方据此报告到底看了哪些。
 */
export function systemDefaultBrowser(platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return readWindowsDefaultBrowser()
  if (platform === 'darwin') return readMacDefaultBrowser()
  return undefined
}

/** 候选列表中出现的不同浏览器 id，按首次出现的顺序。 */
export function detectBrowsers(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): BrowserCandidate[] {
  const groups = browserCandidates(platform, env)
  const found: BrowserCandidate[] = []
  for (const id of DETECTION_ORDER) {
    for (const path of groups[id]) {
      found.push({ id, path, exists: exists(path) })
    }
  }
  return found
}

/**
 * 把路径化成两个路径能直接比较的形式。
 *
 * 记录下来的默认浏览器和候选表来源不同，所以分隔符风格和大小写都不算有意义的差异；
 * 这里把它们抹平，而不是拿去比较。
 */
function distinctIds(candidates: readonly BrowserCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.id))]
}

/** 可执行文件的文件名，按和它来源路径一样的方式归一化。 */
function normaliseExecutablePath(path: string): string {
  return path.trim().replaceAll('/', '\\').replace(/\\+/gu, '\\').toLowerCase()
}

/**
 * 记录下来的默认浏览器可执行文件对应哪个浏览器 id，而且只在恰好匹配一个时才给。
 *
 * 先试完整路径，因为文件名可能重：Chromium 的可执行文件也叫 `chrome.exe`，单看
 * `chrome.exe` 会匹配上两个浏览器，说不清用户指的是哪一个。有歧义的名字就保持未解析，
 * 不去猜——指定错了浏览器，用户会被带到那个没装本扩展的扩展页面上，这正是本函数要防的
 * 那个问题。
 */
function executableFileName(path: string): string {
  const normalised = normaliseExecutablePath(path)
  return normalised.slice(normalised.lastIndexOf('\\') + 1)
}

/**
 * “已经在运行”这条消息该指定哪一个运行中的浏览器。
 *
 * 用户要驱动自己的浏览器，所以记录下来的默认浏览器优先——但只能在实际正在运行的那几个
 * 里选，因为这条消息断言的是其中一个在运行。退回项是按检测顺序的第一个运行中浏览器，
 * `running[0]` 兜最后：先前优先取 `running[0]`，正是它在报告者的机器上指定了 Edge——
 * 那里 Edge 只是碰巧在进程列表里排在前面，而用户要的默认浏览器是 Chrome。
 */
function idOfDefaultExecutable(executable: string | undefined, candidates: readonly BrowserCandidate[]): string | undefined {
  if (executable === undefined || executable === '') return undefined
  const wanted = normaliseExecutablePath(executable)
  const byPath = candidates.find((candidate) => normaliseExecutablePath(candidate.path) === wanted)
  if (byPath !== undefined) return byPath.id
  const name = executableFileName(wanted)
  if (name === '') return undefined
  const ids = new Set(candidates.filter((candidate) => executableFileName(candidate.path) === name).map((candidate) => candidate.id))
  return ids.size === 1 ? [...ids][0] : undefined
}

/**
 * 现在有哪些浏览器在运行，各自用的是哪个 profile。
 *
 * 需要它是因为：对一个已经起来的浏览器再执行启动，对运行中的实例来说是空操作——
 * Windows/macOS/Linux 上的浏览器都会把请求交给既有进程，然后丢掉这些标志。这种状态下，
 * 回复“它已经在运行”才是唯一有用的答案。
 *
 * 这里只读进程列表；不会启动任何进程，也不会给谁发信号。
 *
 * @param platform - 目标平台。
 * @param known - 检测到的候选，用来识别可执行文件。
 * @returns 每个运行中的浏览器进程一项，按 profile 去重。
 */
function runningBrowserId(
  running: readonly RunningBrowser[],
  candidates: readonly BrowserCandidate[],
  defaultExecutable: string | undefined,
): string {
  const ids = new Set(running.map((browser) => browser.id))
  const preferred = idOfDefaultExecutable(defaultExecutable, candidates)
  if (preferred !== undefined && ids.has(preferred)) return preferred
  const byOrder = DETECTION_ORDER.find((id) => ids.has(id))
  return byOrder ?? running[0]?.id ?? 'chrome'
}

// 先写入者胜出：Chromium 的可执行文件也叫 `chrome.exe`，而候选条目
export async function probeRunningBrowsers(
  platform: NodeJS.Platform,
  known: readonly BrowserCandidate[],
  listing: (platform: NodeJS.Platform) => Promise<{ name: string; commandLine: string }[] | undefined> = processListing,
): Promise<RunningBrowser[]> {
  const rows = await listing(platform)
  if (rows === undefined) return []
  const executableNames = new Map<string, string>()
  for (const candidate of known) {
    const name = candidate.path.replaceAll('/', '\\').split('\\').pop()
    // 按检测顺序排列，所以一个正在运行的 Chrome 不会因为“chromium”
    // 那个条目排在后面，就被报成 chromium。
    /** `tasklist`/`ps` 的输出，形如 `{ name, commandLine }`；拿不到时为 undefined。 */
    if (name !== undefined && name !== '' && !executableNames.has(name.toLowerCase())) {
      executableNames.set(name.toLowerCase(), candidate.id)
    }
  }
  const seen = new Set<string>()
  const running: RunningBrowser[] = []
  for (const { name, commandLine } of rows) {
    const id = executableNames.get(name.toLowerCase())
    if (id === undefined) continue
    const match = /--user-data-dir=(?:"([^"]+)"|(\S+))/u.exec(commandLine)
    const userDataDir = match === null ? '' : (match[1] ?? match[2] ?? '')
    const key = `${id}\u0000${userDataDir}`
    if (seen.has(key)) continue
    seen.add(key)
    running.push({ id, userDataDir })
  }
  return running
}

// 现在的 Windows 构建里已经不带 `wmic` 了；把它排在最后，照顾旧版本。
async function processListing(platform: NodeJS.Platform): Promise<{ name: string; commandLine: string }[] | undefined> {
  const { execFile } = await import('node:child_process')
  const attempts: { command: string; args: string[]; parse: (stdout: string) => { name: string; commandLine: string }[] }[] =
    platform === 'win32'
      ? [
          { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_GET_CIM], parse: parsePipeSeparated },
          { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', WIN_GET_WMI], parse: parsePipeSeparated },
          // 命令跑成功但返回空列表，是真实答案（“什么都没在运行”），
          { command: 'wmic', args: ['process', 'get', 'Name,CommandLine', '/format:csv'], parse: parseWmicCsv },
        ]
      : [{ command: 'ps', args: ['-Axo', 'comm=,args='], parse: parsePs }]

  for (const attempt of attempts) {
    const stdout = await runOnce(execFile, attempt.command, attempt.args)
    if (stdout === undefined) continue
    const parsed = attempt.parse(stdout)
    // 而完全没有输出的命令就不算——继续试下一个。
    /** PowerShell：每个进程一行 `Name|CommandLine`。 */
    if (parsed.length > 0 || attempt.command === 'ps') return parsed
  }
  return undefined
}

/** 宿主只带旧版 cmdlet 时的回退方案。 */
const WIN_GET_CIM = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.Name)|$($_.CommandLine)" }'
/**
 * PowerShell：每个浏览器进程有多少个可见顶层窗口。
 *
 * 没有窗口的进程 `MainWindowHandle` 是 0，而这正是这里要查的状态。输出成
 * `name=count`，一次 shell 调用就能把所有浏览器都问清楚，而且没有窗口的进程名会报成
 * `0`，不会被省掉。
 *
 * 有两个特性，第一个正是这条命令写成现在这样的原因。两个都是**实际跑**该命令才发现的，
 * 不是读代码读出来的，其中第二个读起来像是对的，实际是个陷阱：
 *
 * 1. **`Get-Process -Name a,b,c` 只要有一个名字不存在就整体失败。** 一台没装 Brave
 *    或 Chromium 的机器会让整条命令中断——`-ErrorAction SilentlyContinue` 也救不回来——
 *    于是这个探测恰好在本来就为它们而写的那些机器上什么答案都给不出。改成先读所有进程、
 *    再按名字过滤，缺哪个浏览器都无所谓（`-in @(...)` 那份列表就是干这个的）。
 * 2. **计数必须先落到局部变量，再交给格式化运算符。** 把
 *    `Where-Object … ).Count` 内联进 `-f`，产出的那一行就只有名字、没有计数——
 *    `chrome` 而不是 `chrome=1`——解析器随后会把它读成“零个窗口”，
 *    这既与事实相反，又朝着不安全的方向。
 *
 * 命令文本里的双引号没问题：被引号包住的命令作为单个 `execFile` 参数传进去，
 * 能完整到达 PowerShell。
 */
const WIN_GET_WMI = 'Get-WmiObject Win32_Process | ForEach-Object { "$($_.Name)|$($_.CommandLine)" }'

/**
 * 读 `name=count` 这些行：只要有任一浏览器带窗口就是 true，浏览器在运行但没有窗口是
 * false，输出里完全没有可用的答案就是 undefined。
 *
 * `undefined` 不是抠字眼。答不上来的探测绝不能被读成“没有窗口”，因为调用方会照着这个
 * 答案去打开浏览器窗口。
 */
const WIN_WINDOW_COUNTS = [
  'Get-Process -ErrorAction SilentlyContinue |',
  'Where-Object { $_.ProcessName -in @("chrome","msedge","brave","chromium") } |',
  'Group-Object ProcessName |',
  'ForEach-Object { $n = $_.Name;',
  '$c = ($_.Group | Where-Object { $_.MainWindowHandle -ne 0 }).Count;',
  'Write-Output ("{0}={1}" -f $n, $c) }',
].join(' ')

/**
 * 读 `name=count` 那几行：任一浏览器有窗口就是 true，浏览器在跑但都没有窗口是 false，
 * 输出里根本没给出可用答案时是 undefined。
 *
 * `undefined` 不是过度讲究：一个答不上来的探测绝不能被读成“没有窗口”，因为调用方会拿
 * 这个答案去决定要不要打开浏览器窗口。
 */
function parseWindowCounts(stdout: string): boolean | undefined {
  let sawBrowser = false
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^([^=\s]+)=(\d+)$/u.exec(line.trim())
    if (match === null) continue
    sawBrowser = true
    if (Number(match[2]) > 0) return true
  }
  return sawBrowser ? false : undefined
}

/** AppleScript：指定 app 打开了多少个窗口。 */
function macWindowCountScript(appName: string): string {
  return `tell application "System Events" to if exists process "${appName}" `
    + `then return count of windows of process "${appName}" else return -1`
}

/**
 * 运行中的浏览器有没有可见窗口；不知道时是 `undefined`。
 *
 * Chromium 进程比它的窗口活得久：关掉最后一个窗口后进程可能还驻留，扩展也还握着它的
 * socket，于是 bridge 看到的是一条健康连接，随后每个页面工具都以 “no active tab” 失败。
 * 要分清这种状态和真正能用的浏览器，唯一的办法就是问窗口管理器——而 `undefined` 是真实
 * 答案，表示这个平台问不出来，所以调用方不能把它当成“没有窗口”。
 *
 * @param platform - 要问窗口管理器的平台。
 * @param candidates - 要查找的浏览器。
 * @param run - 命令运行器；由测试注入，这样解析逻辑和它驱动的分支都能在不启动 shell 的
 *   情况下验证。
 * @returns true（有窗口）、false（在运行但没有窗口）或 undefined。
 */
export async function hasVisibleBrowserWindow(
  platform: NodeJS.Platform,
  candidates: readonly BrowserCandidate[],
  run: (command: string, args: readonly string[]) => Promise<string | undefined> = defaultRunOnce,
): Promise<boolean | undefined> {
  const windowExecutables = candidateExecutables(candidates, platform)
  if (windowExecutables.length === 0) return undefined

  if (platform === 'win32') {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_WINDOW_COUNTS])
    if (stdout === undefined) return undefined
    return parseWindowCounts(stdout)
  }

  if (platform === 'darwin') {
    let sawBrowser = false
    for (const appName of windowExecutables) {
      const stdout = await run('osascript', ['-e', macWindowCountScript(appName)])
      if (stdout === undefined) continue
      const count = Number(stdout.trim())
      if (!Number.isFinite(count)) continue
      if (count > 0) return true
      if (count === 0) sawBrowser = true
    }
    return sawBrowser ? false : undefined
  }

  // Linux 的窗口管理器和发行版一样多；猜错就可能启动用户没要求的浏览器，
  // 所以这里把答案留空。
  return undefined
}

/** 要去问窗口管理器的候选 app/进程名。 */
/** 真正执行命令的那个运行器；`runOnce` 需要一个此时它还没有的 `execFile`。 */
async function defaultRunOnce(command: string, args: readonly string[]): Promise<string | undefined> {
  const { execFile } = await import('node:child_process')
  return await runOnce(execFile, command, args)
}

// macOS 用的是应用程序包名，不是进程名；这份映射是固定的、简短的，
function candidateExecutables(candidates: readonly BrowserCandidate[], platform: NodeJS.Platform): string[] {
  const names: string[] = []
  for (const candidate of candidates) {
    const file = candidate.path.replaceAll('/', '\\').split('\\').pop() ?? ''
    const stem = file.replace(/\.exe$/iu, '')
    if (stem === '') continue
    // 遇到不认识的包名直接跳过。
    /** `Name|CommandLine` 行，也就是上面那些 PowerShell 命令的输出格式。 */
    const name = platform === 'darwin'
      ? ({ chrome: 'Google Chrome', chromium: 'Chromium', msedge: 'Microsoft Edge', brave: 'Brave Browser' } as Record<string, string>)[stem.toLowerCase()]
      : stem
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

function runOnce(
  execFile: typeof import('node:child_process').execFile,
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error !== null ? undefined : stdout)
    })
  })
}

/** `wmic ... /format:csv` 的行：`Node,Name,CommandLine`（仅旧版 Windows）。 */
export function parsePipeSeparated(stdout: string): { name: string; commandLine: string }[] {
  const parsed: { name: string; commandLine: string }[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf('|')
    if (separator <= 0) continue
    const name = trimmed.slice(0, separator).trim()
    const commandLine = trimmed.slice(separator + 1).trim()
    if (name !== '') parsed.push({ name, commandLine })
  }
  return parsed
}

// CommandLine 本身可能带逗号，所以只切前两段。
export function parseWmicCsv(stdout: string): { name: string; commandLine: string }[] {
  const parsed: { name: string; commandLine: string }[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    /** `ps -Axo comm=,args=` 的行：先是可执行文件路径，然后是它的参数。 */
    const first = line.indexOf(',')
    if (first === -1) continue
    const second = line.indexOf(',', first + 1)
    if (second === -1) continue
    const name = line.slice(first + 1, second).trim()
    const commandLine = line.slice(second + 1).trim()
    if (name !== '' && commandLine !== '') parsed.push({ name, commandLine })
  }
  return parsed
}

/**
 * 一句“没有找到扩展”的话能断言到什么程度，这里以短语形式给出。
 *
 * 它替掉的那句话断言本机任何浏览器 profile 里都不存在，而检查其实只在一个扩展 id 下读了
 * 四个固定目录名——于是商店安装（目录名不同）被报成到处都没有，用户只被指向开发者那条路。
 * 把实际读过的 profile 写出来，这句话就不会超出 bridge 真正看过的范围；连一个根目录都读
 * 不到时，它就照实这么说，而不是断言不存在。
 */
export function parsePs(stdout: string): { name: string; commandLine: string }[] {
  const parsed: { name: string; commandLine: string }[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const space = trimmed.indexOf(' ')
    const name = (space === -1 ? trimmed : trimmed.slice(0, space)).split('/').pop() ?? ''
    if (name !== '') parsed.push({ name, commandLine: trimmed })
  }
  return parsed
}

/**
 * 需要的话启动浏览器，然后等扩展连上来。
 *
 * 顺序很重要：扩展已经连上就说明浏览器正在运行、无事可做，所以只要还有可用的连接就绝不
 * 发起启动——**除非调用方已经确认运行中的浏览器没有窗口了**。Chromium 进程比它最后一个
 * 窗口活得久，这期间扩展一直开着 socket，所以有一条活连接并不等于有东西可操作；
 * `ignoreConnected` 就是让这种情况越过提前返回、向驻留进程要一个窗口的开关。
 *
 * @param deps - 已解析的配置和可注入的副作用。
 * @param connected - bridge 当前有没有已通过认证的扩展。
 * @param url - 可选，要在启动的浏览器里打开的页面。
 * @param ignoreConnected - 强制启动，用在上面那种已知没有窗口的情形里。
 * @returns 发生了什么，措辞里点明下一步。
 */
function profilesReadClause(checked: readonly string[]): string {
  return checked.length > 0
    ? `the browser profiles this bridge read (${checked.join('; ')})`
    : 'the browser profile directories this bridge could locate'
}

// 优先顺序：用户实际在用的浏览器，然后是显式配置的浏览器，
export async function launchBrowser(
  deps: LaunchDeps,
  connected: () => boolean,
  url?: string,
  ignoreConnected = false,
): Promise<LaunchOutcome> {
  if (!ignoreConnected && connected()) {
    return { launched: false, resolved: true, connected: true, message: 'The browser is already running and connected; nothing to launch.' }
  }

  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const candidates = detectBrowsers(platform, env, exists)

  // 然后是找到的第一个 Chromium 系安装。绝不用一个和用户自己的浏览器
  // 不同的浏览器，除非用户按路径点名要了它。
  // `chosen.id` 只是两个按路径解析出来的候选（`default`、`configured`）的占位符，
  const readDefault = deps.executableOfDefaultBrowser
    ?? ((target: NodeJS.Platform) => defaultBrowserExecutable(target, () => systemDefaultBrowser(target)))
  const defaultExecutable = readDefault(platform)
  const configured = deps.executablePath !== undefined && deps.executablePath !== '' ? deps.executablePath : undefined
  const chosen: BrowserCandidate | undefined = defaultExecutable !== undefined && exists(defaultExecutable)
    ? { id: 'default', path: defaultExecutable, exists: true }
    : configured !== undefined
      ? { id: 'configured', path: configured, exists: true }
      : candidates.find((candidate) => candidate.exists)
  const installScan = deps.extensionInstall
    ?? ((target: NodeJS.Platform) => scanExtensionInstalls(
      target,
      env,
      EXTENSION_DIRECTORY_NAMES,
      exists,
      deps.listDirectory ?? readDirectoryNames,
    ))
  // 而不是浏览器名。要在消息里指定浏览器，就得先把可执行文件解析回检测到的 id：
  // `extensionsPageUrl('default')` 匹配不上任何分支，会返回 `chrome://extensions/`，
  // 那是错的页面——而且在修好之前，上面几条消息纠正的正是同一个“指定错浏览器”的方向。
  // 已经起来的浏览器不会因为这次启动加载任何新东西：
  // 请求交给运行中的进程，标志被丢掉。
  const browserId = idOfDefaultExecutable(chosen?.path, candidates) ?? chosen?.id ?? 'chrome'

  if (chosen === undefined) {
    return {
      launched: false,
      resolved: false,
      connected: false,
      message: 'No browser executable was found, so the browser could not be started. '
        + `Looked for: ${distinctIds(candidates).join(', ')} (none present). `
        + 'Ask the user to open their browser — the extension connects on its own once it starts — '
        + 'or set browserExecutablePath in the bridge plugin config.',
    }
  }

  // 启动用户的*默认* profile 恰恰就是这种情况，所以这项检查
  // 正是拦住 bridge、不让它去开一个毫无意义的第二个窗口的东西。
  // 要打开的页面可选，而且必须是真正的网址：这个值最终会进
  // 浏览器的 argv（见 `buildLaunchArgs`），而不可用的值会悄悄
  const probeRunning = deps.probeRunning ?? ((known, wanted) => defaultProbeRunning(platform, known, wanted, deps.processListing))
  const running = await probeRunning(candidates, deps.userDataDir)
  const ownProfile = deps.userDataDir !== undefined && deps.userDataDir !== ''
  const runningSameProfile = running.some((browser) => ownProfile
    ? browser.userDataDir === deps.userDataDir
    : browser.userDataDir === '')
  if (running.length > 0 && !ownProfile && runningSameProfile) {
    const { installed, checked } = installScan(platform)
    const browserId = runningBrowserId(running, candidates, defaultExecutable)
    return {
      launched: false,
      resolved: true,
      connected: false,
      message: `${browserId} is already running, so starting it again would only open a window in the existing one — no extension would load from it. `
        + (installed.length > 0
          ? `The extension is installed in ${installed.join(', ')}; ask the user to make sure it is enabled at ${extensionsPageUrl(browserId)}, and the connection returns on its own.`
          : `The extension was not found in ${profilesReadClause(checked)}, which is why nothing connects. It has to be installed once at ${extensionsPageUrl(browserId)} — from the extension store, or by turning on developer mode and using "Load unpacked" to pick the built extension folder. After that single install a normal start reconnects on its own.`),
      ...(installed.length === 0 ? { installUrl: extensionsPageUrl(browserId) } : {}),
    }
  }

  const loadableExtension = deps.extensionPath !== undefined && deps.extensionPath !== '' && exists(deps.extensionPath)
    ? deps.extensionPath
    : undefined

  // 变成“打开新标签页”，而不是交给那个进程。
  /** 靠真实进程列表来探测，并过滤到所问的那个 profile。 */
  /** 启动一个在插件进程退出后仍继续跑的进程。 */
  const openUrl = webUrlOrUndefined(url)
  const args = buildLaunchArgs(
    {
      ...(loadableExtension === undefined ? {} : { extensionPath: loadableExtension }),
      ...(deps.userDataDir === undefined ? {} : { userDataDir: deps.userDataDir }),
      ...(deps.extraArgs === undefined ? {} : { extraArgs: deps.extraArgs }),
      ...(deps.headless === undefined ? {} : { headless: deps.headless }),
    },
    openUrl,
  )

  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached
  try {
    spawnDetached(chosen.path, args)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      launched: false,
      resolved: true,
      connected: false,
      message: `Starting ${chosen.path} failed: ${detail}. Ask the user to open their browser instead.`,
    }
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  const waitForConnection = deps.waitForConnection ?? ((budget: number) => pollForConnection(budget, connected))
  const connectedAfter = await waitForConnection(timeoutMs)

  if (connectedAfter) {
    return {
      launched: true,
      resolved: true,
      connected: true,
      message: `Started ${chosen.path} and the extension connected. Call browser_snapshot to see the page.`,
    }
  }

  const { installed, checked } = installScan(platform)
  const extensionHint = installed.length > 0
    ? `The extension is installed in ${installed.join(', ')}; confirm it is enabled at ${extensionsPageUrl(browserId)} and that this browser is the one that profile belongs to.`
    : `The extension was not found in ${profilesReadClause(checked)}, so there was nothing to connect. `
      + `It has to be installed once at ${extensionsPageUrl(browserId)} — from the extension store, or by turning on developer mode and using "Load unpacked" to pick the built extension folder; `
      + 'a command-line load only lasts one session and would have to be repeated every start.'
  return {
    launched: true,
    resolved: true,
    connected: false,
    message: `Started ${chosen.path}, but the extension did not connect within ${Math.round(timeoutMs / 1000)}s. ${extensionHint}`,
    ...(installed.length === 0 ? { installUrl: extensionsPageUrl(browserId) } : {}),
  }
}

/**
 * 在用户自己的浏览器里打开扩展页面。
 *
 * 这是用户唯一必须亲手到达的页面，所以 bridge 一确认他们需要它，就*替*他们打开。走操作
 * 系统的处理器，而不是写死某个浏览器，这个页面才会落在用户实际用的浏览器里——包括
 * Firefox，本扩展同样支持它，而任何 Chromium 参数都到不了它。
 *
 * 失败一律悄悄吞掉：打不开一个便利页面，绝不能在本就存在的问题之上再添一个错误。
 *
 * @param url - 扩展页面（`chrome://extensions/` 或 `edge://extensions/`）。
 * @param spawnDetached - 测试注入；默认是分离式 spawn。
 * @param platform - 测试注入。
 */
async function defaultProbeRunning(
  platform: NodeJS.Platform,
  known: readonly BrowserCandidate[],
  wanted: string | undefined,
  listing: LaunchDeps['processListing'],
): Promise<RunningBrowser[]> {
  const running = await probeRunningBrowsers(platform, known, listing ?? processListing)
  if (wanted === undefined || wanted === '') return running
  return running.filter((browser) => browser.userDataDir === wanted)
}

// `start`/`open` 这条路是常规走法；可执行文件那条回退覆盖的是
function defaultSpawnDetached(command: string, args: readonly string[]): void {
  const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
  child.unref()
}

// 宿主没有给这个 URL 方案注册默认处理器的情况。
export async function openExtensionsPage(
  url: string,
  spawnDetached: (command: string, args: readonly string[]) => void = defaultSpawnDetached,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (url === '') return
  if (!/^(https?:|chrome:\/\/|edge:\/\/)/u.test(url)) return
  const { execFile } = await import('node:child_process')
  const opener = platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'start', '', url] }
    : platform === 'darwin'
      ? { command: 'open', args: [url] }
      : { command: 'xdg-open', args: [url] }
  await new Promise<void>((resolve) => {
    execFile(opener.command, opener.args, { windowsHide: true }, () => { resolve() })
  }).catch(() => {})

  // `start`/`open` 这条路是常规走法；可执行文件回退是给那种没为这个 URL 方案注册默认
  // 处理器的机器用的。
  if (platform !== 'win32') return
  try {
    const executable = defaultBrowserExecutable(platform, readWindowsDefaultBrowser)
    if (executable !== undefined) spawnDetached(executable, [url])
  } catch {
    // 没什么可做：页面要么上面已经打开了，要么用户自己能导航过去。
  }
}

/**
 * 默认的连接等待，调用方没有注入宿主专用的等待器时用它。
 *
 * 它必须真的等。早先的版本在调用方没注入等待时会立刻返回 `false`，一次启动于是几毫秒内
 * 就看起来像“启动了，但扩展再也没回来”——而插件自己的调用点恰好注入了真正的等待器，
 * 所以这个缺陷在生产环境和这些注入了等待器的测试里都看不见。
 *
 * @param timeoutMs - 持续询问多久。
 * @param isConnected - 连接判定；就是 bridge 自己的 `hasConnection`。
 * @returns 截止时间之前有没有出现连接。
 */
export async function pollForConnection(timeoutMs: number, isConnected: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (isConnected()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => { setTimeout(resolve, 250) })
    // 暂停之后马上复查：在我们的休眠期间连上来的扩展，
    // 必须赶在下一次完整间隔被等完之前被发现。
    if (isConnected()) return true
  }
}
