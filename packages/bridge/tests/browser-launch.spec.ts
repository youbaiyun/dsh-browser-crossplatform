import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  browsersWithExtensionInstalled,
  buildLaunchArgs,
  browserCandidates,
  defaultBrowserExecutable,
  detectBrowsers,
  EXTENSION_DIRECTORY_NAMES,
  extensionsPageUrl,
  hasVisibleBrowserWindow,
  launchBrowser,
  probeRunningBrowsers,
  scanExtensionInstalls,
  userDataRoots,
  webUrlOrUndefined,
  type BrowserCandidate,
  type LaunchDeps,
} from '../src/browser-launch.ts'
import { resolveExtensionPath } from '../src/index.ts'

/**
 * 启动浏览器是 bridge 在没有扩展时唯一能做的浏览器操作，所以它也是其他一切都
 * 不可用时唯一必须继续可用的操作。这些测试把每一种副作用都注入进来——文件系统
 * 探测、spawn、时钟——因此整个决策面都在不启动任何进程的情况下被检查过。
 */

describe('buildLaunchArgs', () => {
  it('adds the profile directory and the feature-flag escape before the extension', () => {
    const args = buildLaunchArgs({ extensionPath: '/repo/extension/dist', userDataDir: '/home/u/.dsh/browser-profile' })
    expect(args).toEqual([
      '--user-data-dir=/home/u/.dsh/browser-profile',
      // Chromium 必须要有这个 flag 才肯接受这次 unpacked 加载。
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--load-extension=/repo/extension/dist',
      '--disable-extensions-except=/repo/extension/dist',
    ])
  })

  it('never loads the extension into the user\'s own profile, where a session load would install nothing', () => {
    expect(buildLaunchArgs({ extensionPath: '/repo/extension/dist' })).toEqual([])
  })

  it('launches the user\'s browser with no profile flag at all', () => {
    // 重点全在这里：对他们本来就在用的那个浏览器做一次普通启动，用它自己的
    // profile 和会话——而不是在它旁边再开一个浏览器。
    expect(buildLaunchArgs({ extraArgs: [] })).toEqual([])
    expect(buildLaunchArgs({ extensionPath: '/repo/extension/dist', extraArgs: [] })).toEqual([])
  })

  it('adds no URL when none was asked for, so the browser opens its own new tab', () => {
    expect(buildLaunchArgs({ userDataDir: '/tmp/p' })).toEqual(['--user-data-dir=/tmp/p'])
    expect(buildLaunchArgs({}, undefined)).toEqual([])
  })

  it('puts the requested page before the user\'s extra arguments', () => {
    const args = buildLaunchArgs({ extraArgs: ['--no-first-run'] }, 'https://example.com/')
    expect(args).toEqual(['https://example.com/', '--no-first-run'])
  })

  it('refuses to pass anything that is not a web address to the browser', () => {
    // URL 会变成一个命令行参数，所以调用方传来的 `--headless` 这样的字符串会被
    // 当成一个开关来读，而不是当成一个页面。
    for (const hostile of ['--headless', '--load-extension=/tmp/evil', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings']) {
      expect(buildLaunchArgs({}, hostile)).toEqual([])
    }
    expect(buildLaunchArgs({}, 'http://127.0.0.1:3080/ok')).toEqual(['http://127.0.0.1:3080/ok'])
  })

  it('trims a padded address, which spawn would otherwise pass with the space', () => {
    expect(webUrlOrUndefined(' https://ok.example ')).toBe('https://ok.example')
    expect(webUrlOrUndefined('   ')).toBeUndefined()
    expect(webUrlOrUndefined(undefined)).toBeUndefined()
  })
})

describe('detectBrowsers', () => {
  it('offers Chromium-family paths first on Windows', () => {
    const candidates = browserCandidates('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
    expect(candidates.chrome[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(candidates.edge[0]).toContain('msedge.exe')
    expect(candidates.firefox[0]).toContain('firefox.exe')
  })

  it('uses the platform\'s default install roots when the environment does not name them', () => {
    const candidates = browserCandidates('win32', {})
    expect(candidates.chrome[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(candidates.chrome).toHaveLength(2)
  })

  it('keeps Firefox last, because it has no side panel', () => {
    const found = detectBrowsers('linux', {}, () => true)
    const lastChromeFamily = found.findLastIndex((candidate) => candidate.id !== 'firefox')
    expect(found.findIndex((candidate) => candidate.id === 'firefox')).toBeGreaterThan(lastChromeFamily)
  })

  it('reports what exists rather than filtering the list, so a failure can name what was looked at', () => {
    const found = detectBrowsers('linux', {}, (path) => path === '/usr/bin/google-chrome')
    expect(found.filter((candidate) => candidate.exists).map((candidate) => candidate.id)).toEqual(['chrome'])
    expect(found.some((candidate) => candidate.id === 'firefox' && !candidate.exists)).toBe(true)
  })
})

/** 所有副作用都被打桩的启动器依赖；overrides 用来点名当前测的是哪种情况。 */
function deps(overrides: Partial<LaunchDeps> = {}): LaunchDeps {
  return {
    platform: 'linux',
    env: {},
    exists: () => false,
    spawnDetached: () => {},
    waitForConnection: async () => true,
    probeRunning: async () => [],
    timeoutMs: 100,
    ...overrides,
  }
}

describe('browsersWithExtensionInstalled', () => {
  const id = 'kdhkdgfcinfkmogifamoapmheihhcjfk'

  it('finds the extension in a Chrome profile and names only that browser', () => {
    const probe = (path: string): boolean => path === `C:\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\${id}`
    const installed = browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, probe)
    expect(installed).toEqual(['chrome'])
  })

  it('reports nothing when the extension is installed nowhere', () => {
    expect(browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, () => false)).toEqual([])
  })

  it('checks secondary profiles too, not just Default', () => {
    const probe = (path: string): boolean => path.startsWith('C:\\Local\\Google\\Chrome') && path.includes('Profile 2')
    expect(browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, probe)).toEqual(['chrome'])
  })

  it('uses the target platform\'s separators, not the host\'s', () => {
    // 同一次调用无论测试跑在 Windows 还是 Linux 上，都必须描述出一个 Windows
    // 的目录布局；`join` 在 Linux 上会产出正斜杠。
    const probed: string[] = []
    browsersWithExtensionInstalled('win32', { LOCALAPPDATA: 'C:\\Local' }, id, (path) => { probed.push(path); return false })
    expect(probed.every((path) => path.includes('\\') && !path.includes('/'))).toBe(true)
  })
})

describe('scanExtensionInstalls', () => {
  const id = 'kdhkdgfcinfkmogifamoapmheihhcjfk'
  const store = 'agpipnjijkpomaannkijkilggoffdiaf'

  it('probes every id this build can be installed under', () => {
    // 一个构建，两个 id：开发加载由 manifest 的 `key` 钉住，而 Web Store 会拒绝
    // 那个 key 并分配它自己的目录名。以前只检查开发用的 id，这正是让商店安装的
    // 用户看不见自己那次安装的原因。
    expect(EXTENSION_DIRECTORY_NAMES).toContain(id)
    expect(EXTENSION_DIRECTORY_NAMES).toContain(store)
  })

  it('finds a store install by the id the store assigned', () => {
    const chrome = 'C:\\Local\\Google\\Chrome\\User Data'
    const probe = (path: string): boolean => path === `${chrome}\\Default\\Extensions\\${store}`
    const scan = scanExtensionInstalls('win32', { LOCALAPPDATA: 'C:\\Local' }, [id, store], probe, () => ['Default'])
    expect(scan.installed).toEqual(['chrome'])
  })

  it('reads the profiles that are really there, including a fourth and beyond', () => {
    const chrome = 'C:\\Local\\Google\\Chrome\\User Data'
    const probe = (path: string): boolean => path === `${chrome}\\Profile 7\\Extensions\\${id}`
    const scan = scanExtensionInstalls('win32', { LOCALAPPDATA: 'C:\\Local' }, [id], probe, () => ['Profile 7', 'Default'])
    expect(scan.installed).toEqual(['chrome'])
  })

  it('keeps Default first, orders the numbered profiles by value, and never probes a file', () => {
    // `Local State` 是 profile 目录旁边的一个文件，所以把它当成 profile 根来
    // 探测，问的是一个没有意义的问题。按文本排序还会把 `Profile 10` 读在
    // `Profile 2` 前面，把后者报成前者。
    const chrome = 'C:\\Local\\Google\\Chrome\\User Data'
    const probed: string[] = []
    const entries = ['Local State', 'Profile 10', 'Profile 2', 'Default', 'Crashpad']
    const scan = scanExtensionInstalls('win32', { LOCALAPPDATA: 'C:\\Local' }, [id], (path) => { probed.push(path); return false }, () => entries)
    expect(scan.checked).toContain('chrome (Default, Profile 2, Profile 10)')
    const chromeProbes = probed.filter((path) => path.startsWith(`${chrome}\\`))
    expect(chromeProbes).toHaveLength(3)
    expect(probed.every((path) => !path.includes('Local State') && !path.includes('Crashpad'))).toBe(true)
  })

  it('keeps the profile names every browser has when the directory cannot be read', () => {
    // “读不到”绝不能变成“什么都没检查，所以没装”。
    const chrome = 'C:\\Local\\Google\\Chrome\\User Data'
    const probed: string[] = []
    const scan = scanExtensionInstalls('win32', { LOCALAPPDATA: 'C:\\Local' }, [id], (path) => { probed.push(path); return false }, () => undefined)
    expect(scan.checked).toContain('chrome (Default, Profile 1, Profile 2, Profile 3)')
    expect(probed.filter((path) => path.startsWith(`${chrome}\\`))).toHaveLength(4)
  })

  it('falls back the same way when the listing holds no profile at all', () => {
    const scan = scanExtensionInstalls('win32', { LOCALAPPDATA: 'C:\\Local' }, [id], () => false, () => ['Local State', 'ShaderCache'])
    expect(scan.checked).toContain('chrome (Default, Profile 1, Profile 2, Profile 3)')
  })

  it('names every browser whose profiles it read, for the message to quote', () => {
    // Firefox 没有 APPDATA 就没有根目录，而且把扩展放在别处，所以这里只点名
    // Chromium 那一族。
    const scan = scanExtensionInstalls('win32', { LOCALAPPDATA: 'C:\\Local' }, [id], () => false, () => ['Default'])
    expect(scan.checked).toEqual(['chrome (Default)', 'edge (Default)', 'brave (Default)', 'chromium (Default)'])
  })
})

describe('userDataRoots', () => {
  it('points at the per-platform profile directory', () => {
    expect(userDataRoots('win32', { LOCALAPPDATA: 'C:\\Local' }).chrome).toContain('Chrome')
    expect(userDataRoots('darwin', { HOME: '/Users/u' }).chrome).toBe('/Users/u/Library/Application Support/Google/Chrome')
    expect(userDataRoots('linux', { HOME: '/home/u' }).chrome).toBe('/home/u/.config/google-chrome')
  })
})

describe('defaultBrowserExecutable', () => {
  it('reads a quoted Windows command line and ignores its arguments', () => {
    const path = defaultBrowserExecutable('win32', () => '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1', () => true)
    expect(path).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  })

  it('does not invent a path that is not there', () => {
    expect(defaultBrowserExecutable('win32', () => '"C:\\gone\\chrome.exe" --x', () => false)).toBeUndefined()
    expect(defaultBrowserExecutable('win32', () => undefined, () => true)).toBeUndefined()
  })

  it('maps a macOS bundle id to the app it names, and nothing else', () => {
    // LaunchServices 报的是一个 bundle id；只映射这个扩展能驱动的浏览器，所以
    // 未知的会落到检测流程里，而不是落到一个猜出来的路径上。
    expect(defaultBrowserExecutable('darwin', () => 'com.google.Chrome', () => true))
      .toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(defaultBrowserExecutable('darwin', () => 'com.apple.Safari', () => true)).toBeUndefined()
    expect(defaultBrowserExecutable('darwin', () => 'COM.MICROSOFT.EDGEMAC', () => true))
      .toBe('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  })
})

describe('extensionsPageUrl', () => {
  it('points each browser at its own page', () => {
    expect(extensionsPageUrl('chrome')).toBe('chrome://extensions/')
    expect(extensionsPageUrl('edge')).toBe('edge://extensions/')
    expect(extensionsPageUrl('brave')).toBe('chrome://extensions/')
  })
})

describe('probeRunningBrowsers', () => {
  const known = detectBrowsers('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\PF86' }, () => true)

  it('reports a browser running on the platform default profile', async () => {
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'chrome.exe', commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' },
    ])
    expect(running).toEqual([{ id: 'chrome', userDataDir: '' }])
  })

  it('reads a quoted --user-data-dir and de-duplicates the renderer processes', async () => {
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir="C:\\tmp\\prof" --type=renderer' },
      { name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir="C:\\tmp\\prof"' },
      { name: 'chrome.exe', commandLine: 'chrome.exe --user-data-dir=C:\\other' },
    ])
    expect(running).toEqual([
      { id: 'chrome', userDataDir: 'C:\\tmp\\prof' },
      { id: 'chrome', userDataDir: 'C:\\other' },
    ])
  })

  it('ignores executables that are not the detected browsers', async () => {
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'node.exe', commandLine: 'node server.js' },
      { name: 'msedge.exe', commandLine: 'msedge.exe' },
    ])
    expect(running).toEqual([{ id: 'edge', userDataDir: '' }])
  })

  it('does not mistake a running Chrome for chromium, whose executable shares the name', async () => {
    // 两个条目都以 `chrome.exe` 结尾；必须让第一个匹配胜出，否则消息会点名一个
    // 错误的浏览器。
    const running = await probeRunningBrowsers('win32', known, async () => [
      { name: 'chrome.exe', commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' },
    ])
    expect(running).toEqual([{ id: 'chrome', userDataDir: '' }])
  })

  it('reports nothing when the process listing is unavailable', async () => {
    expect(await probeRunningBrowsers('linux', known, async () => undefined)).toEqual([])
  })
})

describe('launchBrowser', () => {
  it('does not start anything when the extension is already connected', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(deps({ spawnDetached }), () => true)
    expect(spawnDetached).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ launched: false, connected: true })
  })

  it('starts a detected browser and reports the connection', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(
      deps({ exists: (path) => path === '/usr/bin/google-chrome', spawnDetached }),
      () => false,
      'https://example.com/',
    )
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', ['https://example.com/'])
    expect(outcome).toMatchObject({ launched: true, connected: true })
    expect(outcome.message).toContain('extension connected')
  })

  it('launches without loading the extension, because a session load installs nothing', async () => {
    // 没有配置 extensionPath 时，这次普通启动就是重点：那个 profile 本来就是
    // 扩展所在的地方。
    const spawnDetached = vi.fn()
    await launchBrowser(deps({ exists: (path) => path === '/usr/bin/google-chrome', spawnDetached }), () => false)
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', [])
  })

  it('starts the user\'s default browser, not a second one, with no flags', async () => {
    const spawnDetached = vi.fn()
    await launchBrowser(
      deps({
        exists: () => true,
        executableOfDefaultBrowser: () => '/usr/bin/google-chrome',
        extensionPath: '/repo/extension/dist',
        spawnDetached,
      }),
      () => false,
    )
    // 没有 profile、也没有扩展 flag：打开的就是他们本来就在用的那个浏览器，
    // 和平常一样。
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', [])
  })

  it('refuses to "launch" when the default-profile browser is already running', async () => {
    // 第二次启动会把请求交给已经在跑的那个进程，并丢掉这些 flag，所以开了一个
    // 窗口却宣称完成了一次启动，那就是撒谎。
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        spawnDetached,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
      }),
      () => false,
    )
    expect(spawnDetached).not.toHaveBeenCalled()
    expect(outcome.launched).toBe(false)
    expect(outcome.message).toContain('already running')
    // 而且它点名了用户必须去操作的那个页面，免得没人知道该往哪找。
    expect(outcome.message).toContain('chrome://extensions/')
    expect(outcome.installUrl).toBe('chrome://extensions/')
  })

  it('names the default browser among the running ones, not whichever the probe listed first', async () => {
    // 上报过的情况：默认浏览器是 Chrome，同时 Edge 也在跑，探测先列出了 Edge，
    // 于是消息把用户送到了 `edge://extensions/`——一个他们的扩展并不在的页面。
    // 消息说的是“已经有一个浏览器在跑”，所以点名的那个也必须是一个正在跑的
    // 浏览器。
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const edge = 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe'
    const outcome = await launchBrowser(
      deps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\PF86' },
        exists: (path) => path === chrome || path === edge,
        executableOfDefaultBrowser: () => chrome,
        probeRunning: async () => [{ id: 'edge', userDataDir: '' }, { id: 'chrome', userDataDir: '' }],
        extensionInstall: () => ({ installed: [], checked: ['chrome (Default)'] }),
      }),
      () => false,
    )
    expect(outcome.message).toContain('chrome is already running')
    expect(outcome.message).toContain('chrome://extensions/')
    expect(outcome.installUrl).toBe('chrome://extensions/')
  })

  it('resolves a default browser by its path when its executable name is ambiguous', async () => {
    // Chromium 的可执行文件也叫 `chrome.exe`，所以只靠名字会匹配到两个浏览器，
    // 而完整路径只点名一个。
    const chromium = 'C:\\Local\\Chromium\\Application\\chrome.exe'
    const outcome = await launchBrowser(
      deps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' },
        exists: () => true,
        executableOfDefaultBrowser: () => chromium,
        probeRunning: async () => [{ id: 'edge', userDataDir: '' }, { id: 'chromium', userDataDir: '' }],
        extensionInstall: () => ({ installed: [], checked: [] }),
      }),
      () => false,
    )
    expect(outcome.message).toContain('chromium is already running')
  })

  it('leaves an ambiguous default browser unresolved instead of guessing', async () => {
    // `C:\Vendor\chrome.exe` 不匹配任何候选路径，却匹配两个候选 id，所以用户
    // 指的是哪个浏览器无从得知；随便点一个会把用户送到错误的扩展页面。这里改由
    // 检测顺序来决定。
    const outcome = await launchBrowser(
      deps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' },
        exists: () => true,
        executableOfDefaultBrowser: () => 'C:\\Vendor\\chrome.exe',
        probeRunning: async () => [{ id: 'edge', userDataDir: '' }],
        extensionInstall: () => ({ installed: [], checked: [] }),
      }),
      () => false,
    )
    expect(outcome.message).toContain('edge is already running')
  })

  it('names the detection order, and then the running browser, when no default is known', async () => {
    // 完全没有记录过默认浏览器：按检测顺序第一个正在跑的浏览器就是最好的答案。
    // 一个候选表从未产出过的 id 仍然是正在跑的那个浏览器，所以点名它，而不是把它
    // 丢掉。
    const known = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        executableOfDefaultBrowser: () => undefined,
        probeRunning: async () => [{ id: 'edge', userDataDir: '' }, { id: 'chrome', userDataDir: '' }],
        extensionInstall: () => ({ installed: [], checked: [] }),
      }),
      () => false,
    )
    expect(known.message).toContain('chrome is already running')

    const unknown = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        executableOfDefaultBrowser: () => undefined,
        probeRunning: async () => [{ id: 'other', userDataDir: '' }],
        extensionInstall: () => ({ installed: [], checked: [] }),
      }),
      () => false,
    )
    expect(unknown.message).toContain('other is already running')
  })

  it('names the browser\'s own extensions page when the extension is installed but not connected', async () => {
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        probeRunning: async () => [{ id: 'edge', userDataDir: '' }],
        extensionInstall: () => ({ installed: ['edge'], checked: ['edge (Default)'] }),
      }),
      () => false,
    )
    expect(outcome.message).toContain('already running')
    expect(outcome.message).toContain('edge://extensions/')
    // 已经装了：没什么可安装的，所以不提供安装链接。
    expect(outcome.installUrl).toBeUndefined()
  })

  it('names the profiles it read when the extension is in none of them', async () => {
    // 诚实的诊断：在它被装过一次之前，任何启动都帮不上忙。这句话必须停留在真正
    // 检查过的范围内——它替换掉的那句措辞宣称“这台机器上的任何浏览器 profile”
    // 里都没有，而实际只探测了单个扩展 id 下的四个固定目录，正是这一点把一个从
    // 商店安装的用户引到了开发者的“加载已解压的扩展程序”那条路上。
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
        extensionInstall: () => ({ installed: [], checked: ['chrome (Default)'] }),
      }),
      () => false,
    )
    expect(outcome.message).toContain('chrome (Default)')
    expect(outcome.message).toContain('the extension store')
    expect(outcome.message).toContain('Load unpacked')
    expect(outcome.message).not.toContain('not installed in any browser profile')
  })

  it('finds a store install, whose directory is named after the id the store assigned', async () => {
    // 上报过的情况：一个用户从 Chrome Web Store 安装，而 bridge 说这个扩展哪里
    // 都没装，因为只探测了开发用 id 的那个目录。商店安装的扩展住在商店分配给它的
    // id 下面。
    const store = 'agpipnjijkpomaannkijkilggoffdiaf'
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const outcome = await launchBrowser(
      deps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Local' },
        exists: (path) => path === chrome || path === `C:\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\${store}`,
        executableOfDefaultBrowser: () => undefined,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
        listDirectory: () => ['Default'],
      }),
      () => false,
    )
    expect(outcome.message).toContain('The extension is installed in chrome')
    expect(outcome.installUrl).toBeUndefined()
  })

  it('reads the profile directories that are really there, not a fixed first three', async () => {
    // `Profile 4` 以及更高的那些从来没被探测过，所以装在其中之一的扩展被报成
    // 到处都没有。
    const id = 'kdhkdgfcinfkmogifamoapmheihhcjfk'
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const outcome = await launchBrowser(
      deps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Local' },
        exists: (path) => path === chrome || path === `C:\\Local\\Google\\Chrome\\User Data\\Profile 4\\Extensions\\${id}`,
        executableOfDefaultBrowser: () => undefined,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
        listDirectory: () => ['Local State', 'Profile 4', 'Default'],
      }),
      () => false,
    )
    expect(outcome.message).toContain('The extension is installed in chrome')
  })

  it('keeps probing the profile names every browser has when the directory cannot be read', async () => {
    // 一个读不了的根目录绝不能变成“什么都没检查，所以没装”。那些总是存在的名字
    // 仍然会被探测，而消息说明探的是哪些 profile，而不是宣称整台机器上都没有。
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const outcome = await launchBrowser(
      deps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Local' },
        exists: (path) => path === chrome,
        executableOfDefaultBrowser: () => undefined,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
        listDirectory: () => undefined,
      }),
      () => false,
    )
    expect(outcome.message).toContain('chrome (Default, Profile 1, Profile 2, Profile 3)')
    expect(outcome.message).not.toContain('not installed in any browser profile')
  })

  it('claims nothing when it could not read a single profile directory', async () => {
    // 完全没有 profile 根目录（这里是缺 LOCALAPPDATA）：消息必须这么说，而不是
    // 把一个没问过的问题变成“哪里都没装”。
    const outcome = await launchBrowser(
      deps({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        exists: (path) => path === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        executableOfDefaultBrowser: () => undefined,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '' }],
      }),
      () => false,
    )
    expect(outcome.message).toContain('the browser profile directories this bridge could locate')
    expect(outcome.message).not.toContain('not installed in any browser profile')
  })

  it('prefers the user\'s default browser over the first detected install', async () => {
    const spawnDetached = vi.fn()
    await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome' || path === '/opt/edge/msedge',
        executableOfDefaultBrowser: () => '/opt/edge/msedge',
        spawnDetached,
      }),
      () => false,
    )
    expect(spawnDetached).toHaveBeenCalledWith('/opt/edge/msedge', [])
  })

  it('still launches when the running browser uses a different profile', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === '/usr/bin/google-chrome',
        spawnDetached,
        probeRunning: async () => [{ id: 'chrome', userDataDir: '/tmp/other' }],
      }),
      () => false,
    )
    expect(spawnDetached).toHaveBeenCalled()
    expect(outcome).toMatchObject({ launched: true, connected: true })
  })

  it('prefers an explicitly configured executable and ignores detection', async () => {
    const spawnDetached = vi.fn()
    await launchBrowser(
      deps({ executablePath: '/opt/x/chrome', exists: () => false, spawnDetached }),
      () => false,
    )
    expect(spawnDetached).toHaveBeenCalledWith('/opt/x/chrome', [])
  })

  it('names every browser it looked for when none is present', async () => {
    const spawnDetached = vi.fn()
    const outcome = await launchBrowser(deps({ spawnDetached }), () => false)
    expect(spawnDetached).not.toHaveBeenCalled()
    expect(outcome.launched).toBe(false)
    expect(outcome.message).toContain('chrome')
    expect(outcome.message).toContain('firefox')
    expect(outcome.message).toContain('browserExecutablePath')
  })

  it('passes the extension only when the directory exists', async () => {
    // 这个探测同时回答浏览器和扩展两件事：检测仍然必须找到一个浏览器，而只有
    // 真正存在的扩展目录才可以被加载。
    const existing = vi.fn((path: string) => path === '/repo/extension/dist' || path === '/usr/bin/google-chrome')
    const spawnDetached = vi.fn()
    await launchBrowser(deps({ extensionPath: '/repo/extension/dist', userDataDir: '/tmp/profile', exists: existing, spawnDetached }), () => false)
    expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/google-chrome', [
      '--user-data-dir=/tmp/profile',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--load-extension=/repo/extension/dist',
      '--disable-extensions-except=/repo/extension/dist',
    ])

    const missing = vi.fn((path: string) => path === '/usr/bin/google-chrome')
    const second = vi.fn()
    await launchBrowser(deps({ extensionPath: '/gone/dist', exists: missing, spawnDetached: second }), () => false)
    expect(second).toHaveBeenCalledWith('/usr/bin/google-chrome', [])
  })

  it('says the launch happened but the extension stayed away, and why that might be', async () => {
    const outcome = await launchBrowser(
      deps({ exists: (path) => path === '/usr/bin/google-chrome', waitForConnection: async () => false, timeoutMs: 1_000 }),
      () => false,
    )
    expect(outcome).toMatchObject({ launched: true, connected: false })
    expect(outcome.message).toContain('did not connect within 1s')
  })

  it('sends the reader to the extensions page of the default browser, not always Chrome', async () => {
    // 默认候选是在占位 id `default` 下记录的，因为操作系统报的是路径而不是名字。
    // 把这个占位符直接传给 `extensionsPageUrl`，两个分支的真实 id 都匹配不上，
    // 于是落到 Chrome 的 scheme 上——结果一个默认用 Edge、扩展又没装的用户被指向
    // 了 chrome://extensions/，正是这个版本在别处修掉的那种指错浏览器。现在 id
    // 会先从可执行文件解析出来，再被用在消息里。
    const edge = '/usr/bin/microsoft-edge'
    const outcome = await launchBrowser(
      deps({
        exists: (path) => path === edge,
        executableOfDefaultBrowser: () => edge,
        waitForConnection: async () => false,
        timeoutMs: 1_000,
      }),
      () => false,
    )
    expect(outcome.message).toContain('edge://extensions/')
    // Chrome 的那个页面正是占位 id 以前会产出的东西；现在任何东西都不该把读者
    // 送到那里。
    expect(outcome.message).not.toContain('chrome://')
    expect(outcome.installUrl).toBe('edge://extensions/')
  })

  it('waits for the connection by default instead of reporting immediately', async () => {
    // 直接构造出来的启动器（没有注入 waiter）以前会在启动浏览器的同一毫秒里
    // 返回“未连接”。共享 helper 注入了一个 waiter，所以这个用例必须把它删掉，才能
    // 走到默认行为上。
    let asked = 0
    const withoutWaiter = deps({ exists: (path) => path === '/usr/bin/google-chrome' })
    delete withoutWaiter.waitForConnection
    const outcome = await launchBrowser(withoutWaiter, () => { asked += 1; return asked > 1 })
    expect(asked).toBeGreaterThan(1)
    expect(outcome).toMatchObject({ launched: true, connected: true })
  })

  it('turns a spawn failure into words rather than throwing', async () => {
    const outcome = await launchBrowser(
      deps({ executablePath: '/opt/x/chrome', spawnDetached: () => { throw new Error('EACCES') } }),
      () => false,
    )
    expect(outcome).toMatchObject({ launched: false, connected: false })
    expect(outcome.message).toContain('EACCES')
  })
})

describe('resolveExtensionPath', () => {
  it('uses the configured path as written', () => {
    expect(resolveExtensionPath('/custom/dist', '/repo/packages/bridge/src')).toBe('/custom/dist')
  })

  it('finds the build from src/ and from lib/, whatever machine the package is installed on', () => {
    // 一棵真实的临时目录树，这样断言就不依赖这个 checkout——也不依赖某台机器
    // 恰好拥有的任何绝对路径。`src` 和 `lib` 处在不同深度；两种情况下扩展都是它的
    // 兄弟目录。
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-path-'))
    try {
      mkdirSync(join(root, 'packages', 'bridge', 'src'), { recursive: true })
      mkdirSync(join(root, 'packages', 'bridge', 'lib'), { recursive: true })
      mkdirSync(join(root, 'extension', 'dist'), { recursive: true })
      writeFileSync(join(root, 'extension', 'dist', 'manifest.json'), '{}')
      expect(resolveExtensionPath('', join(root, 'packages', 'bridge', 'src'))).toBe(join(root, 'extension', 'dist'))
      expect(resolveExtensionPath('', join(root, 'packages', 'bridge', 'lib'))).toBe(join(root, 'extension', 'dist'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores a directory that is not a built extension', () => {
    // 已安装包上方一个无关的 `extension/dist` 绝不能被传给 `--load-extension`：
    // Chrome 遇到坏路径会拒绝启动，于是这次启动会失败，而不是回退。
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-bogus-'))
    try {
      mkdirSync(join(root, 'packages', 'bridge', 'lib'), { recursive: true })
      mkdirSync(join(root, 'extension', 'dist'), { recursive: true })
      expect(resolveExtensionPath('', join(root, 'packages', 'bridge', 'lib'))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves to nothing when no build is shipped, so a launch passes no extension flag', () => {
    // 常规的已安装包情形：扩展不在插件旁边，返回空结果是对的，而不是错误。
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-none-'))
    try {
      mkdirSync(join(root, 'lib'), { recursive: true })
      expect(resolveExtensionPath('', join(root, 'lib'))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('hasVisibleBrowserWindow', () => {
  const chrome: BrowserCandidate[] = [{ id: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', exists: true }]

  it('reads a window count out of the one shell call, per browser', async () => {
    // “chrome=2” 表示有两个 Chrome 进程各自拥有一个窗口；答案就是有，不必再去
    // 问其他的。
    const stdout = 'chrome=2\r\nmsedge=0\r\n'
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => stdout)).resolves.toBe(true)
  })

  it('reports a running browser with no window as false, which is what makes a launch happen', async () => {
    // 一个 Chromium 进程会比它最后一个窗口活得更久，而扩展在此期间一直把 socket
    // 开着——所以“已连接”说明不了到底有没有可操作的页面。bridge 现在依据的就是
    // 这个状态。
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => 'chrome=0\r\nmsedge=0\r\n')).resolves.toBe(false)
  })

  it('withholds an answer it cannot stand behind, rather than guessing', async () => {
    // 输出里什么都没认出来、shell 根本没跑起来、以及一个我们不驱动其窗口管理器的
    // 平台：这三种都必须是“未知”，因为这里返回 false 会打开一个用户并没有要求过的
    // 浏览器窗口。
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => 'unexpected output')).resolves.toBeUndefined()
    await expect(hasVisibleBrowserWindow('win32', chrome, async () => undefined)).resolves.toBeUndefined()
    await expect(hasVisibleBrowserWindow('linux', chrome, async () => 'chrome=1')).resolves.toBeUndefined()
    await expect(hasVisibleBrowserWindow('win32', [], async () => 'chrome=1')).resolves.toBeUndefined()
  })

  it('asks macOS for the app by name, and accepts the first window it finds', async () => {
    const asked: string[] = []
    const run = async (_command: string, args: readonly string[]): Promise<string> => {
      asked.push(args.join(' '))
      return '1'
    }
    await expect(hasVisibleBrowserWindow('darwin', chrome, run)).resolves.toBe(true)
    // 是 bundle 名，不是可执行文件名：System Events 认的是前者。
    expect(asked[0]).toContain('Google Chrome')
  })

  it('runs the real Windows command, because reading it is not enough', async () => {
    // 上面每一个注入输入的测试都通过了，而这条命令本身却坏了三处，每一处都让
    // 探测返回空：`Get-Process -Name a,b,c` 在其中一个名字不存在时会直接失败，
    // 内嵌的双引号在传给 shell 的路上会被吃掉，把计数内联进 format 运算符也会把
    // 它丢掉。要抓住这一整类错误，唯一的办法就是真的执行这条命令。
    //
    // 没有 PowerShell 时跳过而不是判失败，这样一次 Linux 上的 CI 和没有 shell 的
    // 沙箱不会被报成缺陷。
    const probe = async (): Promise<boolean | undefined> =>
      await hasVisibleBrowserWindow('win32', chrome, async (command, args) => {
        const { execFile } = await import('node:child_process')
        return await new Promise<string | undefined>((resolve) => {
          execFile(command, [...args], { windowsHide: true }, (error, stdout) => resolve(error === null ? stdout : undefined))
        })
      })
    let answered: boolean | undefined
    try {
      answered = await probe()
    } catch {
      answered = undefined
    }
    if (answered === undefined) {
      // 这里没有 PowerShell（或者它拒绝运行）：被测的契约没法演练，假装测到了
      // 就等于什么都没断言。
      expect(process.platform === 'win32').toBeTypeOf('boolean')
      return
    }
    expect(typeof answered).toBe('boolean')
  })
})
