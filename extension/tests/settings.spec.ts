// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  CONTROL_PORT_NAME,
  SETTINGS_DEFAULTS,
  SETTINGS_STORAGE_KEY,
  normalizeSettings,
  type Settings,
} from '../src/settings.ts'

/** 完全按存储读取器的方式，规范化一个不可信的候选值。 */
function normalize(candidate: unknown): Settings {
  return normalizeSettings(candidate as Partial<Settings> | undefined)
}

describe('normalizeSettings', () => {
  it('keeps a valid vision tier and refuses to guess at anything else', () => {
    expect(normalizeSettings({ visionTier: 'low' }).visionTier).toBe('low')
    expect(normalizeSettings({ visionTier: 'enhanced' }).visionTier).toBe('enhanced')
    // 一个坏掉的存储值必须落在安全的档位上，不是最便宜的档位上：两者的差别在于
    // 图片到底会不会离开这台机器。
    expect(normalizeSettings({ visionTier: 'nonsense' } as unknown as Partial<Settings>).visionTier).toBe('off')
    expect(normalizeSettings(undefined).visionTier).toBe('off')
  })

  it('trims the direct vision settings and defaults them to empty', () => {
    const normalized = normalizeSettings({
      visionEndpoint: '  https://api.example.com/v1  ',
      visionModel: ' custom-vision ',
      visionApiKey: ' secret ',
    })
    expect(normalized.visionEndpoint).toBe('https://api.example.com/v1')
    expect(normalized.visionApiKey).toBe('secret')
    expect(normalizeSettings(undefined).visionEndpoint).toBe('')
    // 模型算配置项，是因为端点也算：把浏览器指向另一家 provider，而 id 却固定
    // 不变，发过去的名字那家 provider 从没听说过。空值表示「采用共享默认值」，
    // 由调用方去解析，所以从不设置它的安装也是对的。
    expect(normalized.visionModel).toBe('custom-vision')
    expect(normalizeSettings({ visionModel: '   ' }).visionModel).toBe('')
  })

  it('falls back to the defaults for an empty or missing candidate', () => {
    const fromUndefined = normalizeSettings(undefined)
    expect(fromUndefined).toEqual(SETTINGS_DEFAULTS)
    // 结果是一个全新对象，不是那份共享的默认值记录。
    expect(fromUndefined).not.toBe(SETTINGS_DEFAULTS)

    expect(normalize({})).toEqual(SETTINGS_DEFAULTS)
    // 存储值缺失、或者坏成了非对象，都不能抛异常。
    expect(normalize(null)).toEqual(SETTINGS_DEFAULTS)
    expect(normalize('not settings')).toEqual(SETTINGS_DEFAULTS)
    expect(normalize(7)).toEqual(SETTINGS_DEFAULTS)

    expect(SETTINGS_DEFAULTS).toEqual({
      bridgeUrl: '',
      token: '',
      sharePageContent: 'auto',
      visionTier: 'off',
      visionEndpoint: '',
      visionModel: '',
      visionApiKey: '',
      unrestrictedBrowserAccess: true,
      trustedActionOrigins: [],
      approvalNotifications: true,
      autoOpenPanel: true,
      // 跟着用户切到的标签页走是出厂默认值；控制条可以把它改回「询问」，那个模式永远
      // 不会自己挪动目标。
      tabSwitch: 'follow',
      // 跟桌面端的浏览器工作区保持一致，这样在那里发出的指令不用先被选中就会显示
      // 出来。
      sessionScope: 'workspace',
      readWidth: 640,
    })
    // 每个字段始终存在，面板永远不会渲染出 `undefined`。
    expect(Object.keys(fromUndefined).sort()).toEqual([
      'approvalNotifications',
      'autoOpenPanel',
      'bridgeUrl',
      'readWidth',
      'sessionScope',
      'sharePageContent',
      'tabSwitch',
      'token',
      'trustedActionOrigins',
      'unrestrictedBrowserAccess',
      'visionApiKey',
      'visionEndpoint',
      'visionModel',
      'visionTier',
    ])
  })

  it('trims bridgeUrl and token, rejecting non-string values', () => {
    expect(normalize({
      bridgeUrl: '  ws://127.0.0.1:8799/bridge  ',
      token: '  bearer-token  ',
    })).toMatchObject({
      bridgeUrl: 'ws://127.0.0.1:8799/bridge',
      token: 'bearer-token',
    })

    // 全是空白的输入会收敛成空值，也就是「自动发现」那个取值。
    expect(normalize({ bridgeUrl: '   ', token: '\t' }))
      .toMatchObject({ bridgeUrl: '', token: '' })
    expect(normalize({ bridgeUrl: 42, token: null }))
      .toMatchObject({ bridgeUrl: '', token: '' })
  })

  it('accepts only ask/auto for sharePageContent, and folds the retired "off" onto ask', () => {
    expect(normalize({ sharePageContent: 'ask' }).sharePageContent).toBe('ask')
    expect(normalize({ sharePageContent: 'auto' }).sharePageContent).toBe('auto')
    // `'off'` 是已删掉的那一档。存过它的用户必须落到 `'ask'`——他们当年选的是
    // "更严格的一档"，降级成"什么都不问"正好把意图反着实现。
    expect(normalize({ sharePageContent: 'off' }).sharePageContent).toBe('ask')

    for (const invalid of ['sometimes', 'ON', '', true, 1, null, undefined, {}]) {
      expect(normalize({ sharePageContent: invalid }).sharePageContent).toBe('auto')
    }
  })

  it('keeps unrestrictedBrowserAccess a strict boolean, falling back to the default', () => {
    // 明确做出的选择两个方向都保留——把开关关掉的用户会保持关闭，这才让
    // 这个开关有意义。
    expect(normalize({ unrestrictedBrowserAccess: true }).unrestrictedBrowserAccess).toBe(true)
    expect(normalize({ unrestrictedBrowserAccess: false }).unrestrictedBrowserAccess).toBe(false)

    // 任何不是布尔值的东西都回退到出厂默认值，而不是 `false`。以前那种写法
    // （`source.x === true`）会把每个读不出来的值都把这个字段钉死为 `false`，于是
    // 默认值在 `SETTINGS_DEFAULTS` 里改了也没用，这一行会悄悄把它撤销——事情正是这样
    // 发生的。
    for (const loose of ['true', 'yes', '1', 1, 0, null, undefined, {}, []]) {
      expect(normalize({ unrestrictedBrowserAccess: loose }).unrestrictedBrowserAccess)
        .toBe(SETTINGS_DEFAULTS.unrestrictedBrowserAccess)
    }
    // 这里也明写一遍，好让意图在默认值被改动后依然成立：一份对该字段只字未提的记录
    // 拿到的是默认值，不是「关闭」。
    expect(normalize({}).unrestrictedBrowserAccess).toBe(SETTINGS_DEFAULTS.unrestrictedBrowserAccess)
  })

  it('de-duplicates and sorts trustedActionOrigins, dropping invalid entries', () => {
    const settings = normalize({
      trustedActionOrigins: [
        ' https://docs.example.com/guide ',
        'https://app.example.com',
        'https://app.example.com/',
        'not an origin',
        'ftp://files.example.com',
        'https://user:pass@secret.example.com',
        42,
        null,
        '*.example.com',
        'https://*.example.com',
      ],
    })

    expect(settings.trustedActionOrigins).toEqual([
      'https://*.example.com',
      'https://app.example.com',
      'https://docs.example.com',
    ])
  })

  it('keeps an empty allowlist when the candidate has no usable origin list', () => {
    expect(normalize({ trustedActionOrigins: [] }).trustedActionOrigins).toEqual([])
    expect(normalize({ trustedActionOrigins: 'https://app.example.com' }).trustedActionOrigins).toEqual([])
    expect(normalize({ trustedActionOrigins: [42, 'nonsense'] }).trustedActionOrigins).toEqual([])
  })

  it('defaults approvalNotifications unless explicitly disabled', () => {
    expect(normalize({})).toMatchObject({ approvalNotifications: true })
    expect(normalize({ approvalNotifications: true })).toMatchObject({ approvalNotifications: true })
    expect(normalize({ approvalNotifications: false })).toMatchObject({ approvalNotifications: false })

    // 任何不是字面量 `false` 的值都保持默认。
    for (const notFalse of ['false', 0, null, undefined, {}, []]) {
      expect(normalize({ approvalNotifications: notFalse })).toMatchObject({ approvalNotifications: true })
    }
  })

  it('keeps the reading cap inside a range that is still a line length', () => {
    expect(normalize({ readWidth: 800 }).readWidth).toBe(800)
    // 比可用栏宽更窄的会被抬高，宽得离谱的会被封顶。
    expect(normalize({ readWidth: 120 }).readWidth).toBe(360)
    expect(normalize({ readWidth: 9000 }).readWidth).toBe(1200)
    for (const invalid of [undefined, null, 'wide', Number.NaN, {}]) {
      expect(normalize({ readWidth: invalid }).readWidth).toBe(640)
    }
  })

  it('accepts only the three tab-switch modes, defaulting to follow', () => {
    expect(normalize({ tabSwitch: 'follow' }).tabSwitch).toBe('follow')
    expect(normalize({ tabSwitch: 'keep' }).tabSwitch).toBe('keep')
    expect(normalize({ tabSwitch: 'ask' }).tabSwitch).toBe('ask')
    // 拿默认值比，不拿字面量比，这样改出厂默认值时不必连这份列表一起改，而且
    // 无效的值永远不会悄悄变成一个合法模式。
    for (const invalid of ['always', 'FOLLOW', '', true, 1, null, undefined, {}]) {
      expect(normalize({ tabSwitch: invalid }).tabSwitch).toBe(SETTINGS_DEFAULTS.tabSwitch)
    }
  })

  it('accepts the three conversation scopes, defaulting to mirroring all workspaces', () => {
    expect(normalize({ sessionScope: 'fresh' }).sessionScope).toBe('fresh')
    expect(normalize({ sessionScope: 'last' }).sessionScope).toBe('last')
    expect(normalize({ sessionScope: 'workspace' }).sessionScope).toBe('workspace')
    for (const invalid of ['current', 'LAST', '', true, 1, null, undefined, {}]) {
      expect(normalize({ sessionScope: invalid }).sessionScope).toBe(SETTINGS_DEFAULTS.sessionScope)
    }
  })

  it('folds the retired "pinned" scope onto "last" instead of the default', () => {
    // `pinned` 那一档已经并入 `last`。让它掉到默认值 `workspace` 会把"接着自己那段
    // 对话"的用户改到"镜像全部工作区"——那不是他选的东西。所以这条迁移路径单独钉住。
    expect(normalize({ sessionScope: 'pinned' }).sessionScope).toBe('last')
    // 只剩 `pinnedSessionId` 的旧记录：那个字段已经删掉了，范围落回默认。
    expect(normalize({ sessionScope: 'fresh', pinnedSessionId: 'session-7' }).sessionScope).toBe('fresh')
    expect('pinnedSessionId' in normalize({ pinnedSessionId: 'session-7' })).toBe(false)
  })

  it('preserves a complete, already-normalized candidate', () => {
    const candidate: Settings = {
      bridgeUrl: 'ws://127.0.0.1:8799/bridge',
      token: 'bearer-token',
      sharePageContent: 'ask',
      visionTier: 'standard',
      visionEndpoint: 'https://api.example.com/v1',
      visionModel: 'custom-vision',
      visionApiKey: 'secret',
      unrestrictedBrowserAccess: true,
      trustedActionOrigins: ['https://app.example.com'],
      approvalNotifications: false,
      autoOpenPanel: false,
      tabSwitch: 'ask',
      sessionScope: 'last',
      readWidth: 800,
    }

    expect(normalizeSettings(candidate)).toEqual(candidate)
  })

  it('never mutates SETTINGS_DEFAULTS and returns an independent allowlist', () => {
    const before = {
      ...SETTINGS_DEFAULTS,
      trustedActionOrigins: [...SETTINGS_DEFAULTS.trustedActionOrigins],
    }

    const dirty = normalize({
      bridgeUrl: ' not-a-url ',
      token: 12,
      sharePageContent: 'whenever',
      unrestrictedBrowserAccess: 'yes',
      trustedActionOrigins: ['https://app.example.com', 'bogus'],
      approvalNotifications: null,
      fixedWidth: 'no',
    })

    expect(SETTINGS_DEFAULTS).toEqual(before)

    // 规范化后的白名单是全新数组：调用方改自己收到的东西，破坏不了默认值或
    // 下一次读取。
    dirty.trustedActionOrigins.push('https://evil.example.com')
    expect(normalizeSettings(undefined).trustedActionOrigins).toEqual([])
    expect(SETTINGS_DEFAULTS.trustedActionOrigins).toEqual([])
    expect(SETTINGS_DEFAULTS).toEqual(before)
  })
})

describe('settings constants', () => {
  it('pins the storage key and the control-strip port both ends share', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('dshSettings')
    expect(CONTROL_PORT_NAME).toBe('dsh-control')
  })
})
