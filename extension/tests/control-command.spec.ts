// @vitest-environment jsdom

/**
 * composer 输入分类器的测试。
 *
 * 分类器决定一行输入是在浏览器里执行，还是发给
 * 模型，所以真正要紧的是那些模棱两可的情形：一个裸词、一句
 * 以工具名开头的句子、带路径的 URL、格式错误的 JSON。
 */

import { describe, expect, it } from 'vitest'
import {
  BROWSER_TOOL_NAMES,
  OPEN_DEFAULTS,
  classifyInput,
  isSoftOpenError,
  parseOpenDirective,
  parseUrlLike,
  requiresConfirmArgument,
  type OpenError,
} from '../control/command.ts'

describe('classifyInput', () => {
  it('recognizes an explicit tool name with JSON arguments', () => {
    const intent = classifyInput('browser_click {"index":3,"frame":0}')
    expect(intent).toEqual({
      kind: 'command',
      name: 'browser_click',
      args: { index: 3, frame: 0 },
      echo: 'browser_click {"index":3,"frame":0}',
    })
  })

  it('recognizes key=value arguments and types them', () => {
    expect(classifyInput('click index=3 frame=1')).toMatchObject({
      kind: 'command',
      name: 'browser_click',
      args: { index: 3, frame: 1 },
    })
    expect(classifyInput('type index=2 text="hello world"')).toMatchObject({
      kind: 'command',
      name: 'browser_type',
      args: { index: 2, text: 'hello world' },
    })
    expect(classifyInput('snapshot delta=true')).toMatchObject({
      kind: 'command',
      name: 'browser_snapshot',
      args: { delta: true },
    })
  })

  it('maps the shorthand words people actually type', () => {
    expect(classifyInput('snapshot')).toMatchObject({ kind: 'command', name: 'browser_snapshot', args: {} })
    expect(classifyInput('tabs')).toMatchObject({ kind: 'command', name: 'browser_list_tabs', args: {} })
    expect(classifyInput('back')).toMatchObject({ kind: 'command', name: 'browser_back', args: {} })
    // 动词不区分大小写，所以 `Click` 也可以。
    expect(classifyInput('Click index=7')).toMatchObject({ kind: 'command', name: 'browser_click', args: { index: 7 } })
  })

  it('fills in the arguments a tool implies', () => {
    // 开头的 URL 就是目标，scroll 默认往下翻一页。
    expect(classifyInput('browser_navigate https://example.com/a?b=1')).toMatchObject({
      kind: 'command',
      name: 'browser_navigate',
      args: { url: 'https://example.com/a?b=1' },
    })
    expect(classifyInput('scroll')).toMatchObject({
      kind: 'command',
      name: 'browser_scroll',
      args: { direction: 'down' },
    })
    expect(classifyInput('scroll up')).toMatchObject({
      kind: 'command',
      name: 'browser_scroll',
      args: { direction: 'up' },
    })
  })

  it('treats a bare URL or dotted host as navigation', () => {
    expect(classifyInput('https://example.com/help')).toMatchObject({
      kind: 'command',
      name: 'browser_navigate',
      args: { url: 'https://example.com/help' },
    })
    expect(classifyInput('example.com')).toMatchObject({
      kind: 'command',
      name: 'browser_navigate',
      args: { url: 'https://example.com/' },
    })
  })

  it('sends anything else to the model', () => {
    expect(classifyInput('总结这个页面')).toEqual({ kind: 'prompt', text: '总结这个页面' })
    expect(classifyInput('summarize the page and list the links')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('read the docs please')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('')).toEqual({ kind: 'prompt', text: '' })
  })

  it('treats a single-label host as prose unless it is really a host', () => {
    // `wiki` 是一个词；`localhost` 和裸 IP 是人们会敲进去的地址。
    expect(classifyInput('wiki')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('localhost:8080')).toMatchObject({ kind: 'command', name: 'browser_navigate' })
    expect(classifyInput('127.0.0.1:3080')).toMatchObject({ kind: 'command', name: 'browser_navigate' })
  })

  it('keeps an explicit tool name a command even when the arguments are unreadable', () => {
    // `browser_*` 毫不含糊；后台会校验这次调用，
    // 判不出来就失败关闭，这比把它转发给模型强。
    expect(classifyInput('browser_click oops')).toMatchObject({
      kind: 'command',
      name: 'browser_click',
      args: {},
    })
  })

  it('treats a shorthand with prose after it as a prompt', () => {
    // `read` 也是个普通英文单词；只有干净的参数列表才让它成为
    // 命令，所以这里还是交给模型。
    expect(classifyInput('read the docs please')).toMatchObject({ kind: 'prompt' })
    expect(classifyInput('read index=3')).toMatchObject({
      kind: 'command',
      name: 'browser_get_text',
      args: { index: 3 },
    })
  })

  it('collapses whitespace in the echoed command', () => {
    expect(classifyInput('  click    index=3  ')).toMatchObject({
      kind: 'command',
      echo: 'click index=3',
    })
  })
})

describe('parseUrlLike', () => {
  it('accepts complete URLs and single dotted hosts', () => {
    expect(parseUrlLike('https://example.com/a')).toBe('https://example.com/a')
    expect(parseUrlLike('example.com/a')).toBe('https://example.com/a')
    expect(parseUrlLike('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })

  it('refuses prose, other schemes, and dotted words inside a sentence', () => {
    expect(parseUrlLike('hello world')).toBeUndefined()
    expect(parseUrlLike('file:///etc/passwd')).toBeUndefined()
    expect(parseUrlLike('chrome://extensions')).toBeUndefined()
    expect(parseUrlLike('check example.com now')).toBeUndefined()
    expect(parseUrlLike('')).toBeUndefined()
  })
})

describe('tool surface', () => {
  it('exposes every browser tool once', () => {
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(BROWSER_TOOL_NAMES.length)
    expect(BROWSER_TOOL_NAMES).toContain('browser_close_tab')
  })

  it('agrees with the registry the background actually dispatches', () => {
    // composer 的列表是从 `src/background/tools.ts` 导入的，而
    // 后台会拒掉任何不在自己注册表里的名字。指向后台不认识的
    // 名字的简写就是一条死命令，所以
    // 这里把每个别名都解析回真实的工具。
    for (const word of ['snapshot', 'read', 'text', 'click', 'type', 'fill', 'press', 'key', 'scroll', 'wait', 'tabs', 'back', 'forward', 'reload']) {
      const intent = classifyInput(word)
      expect(intent.kind, `shorthand "${word}" must resolve to a command`).toBe('command')
      if (intent.kind === 'command') expect(BROWSER_TOOL_NAMES).toContain(intent.name)
    }
  })

  it('requires an explicit confirmation only for closing a tab', () => {
    expect(requiresConfirmArgument('browser_close_tab')).toBe(true)
    expect(requiresConfirmArgument('browser_click')).toBe(false)
  })
})

describe('@open directive', () => {
  it('parses the documented formula and fills in the defaults', () => {
    const parsed = parseOpenDirective('@open https://store.steampowered.com')
    expect(parsed?.url).toBe('https://store.steampowered.com/')
    // 省略所有键得到的是文档里写的默认值，不是空对象。
    expect(parsed?.options).toEqual(OPEN_DEFAULTS)
  })

  it('accepts every documented key', () => {
    const parsed = parseOpenDirective('@open https://example.com pace=slow pin=off')
    expect(parsed?.options).toEqual({ pace: 'slow', pin: false })
  })

  it('rejects a key it does not implement rather than accepting and ignoring it', () => {
    // `verify` 以前会解析，然后什么都不做，这比直接拒绝更糟：
    // 用户会以为自己拿到了一项从没得到的保证。一个
    // 看起来有效却什么都不做的参数，比被拒绝的参数更糟。
    const parsed = parseOpenDirective('@open https://example.com verify=step')
    expect(parsed?.error?.kind).toBe('unknownKey')
    if (parsed?.error?.kind === 'unknownKey') expect(parsed.error.key).toBe('verify')
  })

  it('accepts the whole-domain shorthand the URL helper understands', () => {
    expect(parseOpenDirective('@open example.com')?.url).toBe('https://example.com/')
  })

  it('exposes the directive as its own intent, not a command or a prompt', () => {
    const intent = classifyInput('@open https://example.com pace=fast')
    expect(intent.kind).toBe('open')
    if (intent.kind !== 'open') throw new Error('unreachable')
    expect(intent.url).toBe('https://example.com/')
    expect(intent.options.pace).toBe('fast')
    // 回显是面板展示的东西，所以它就是清理后的原始行。
    expect(intent.echo).toBe('@open https://example.com pace=fast')
  })

  it('treats @show and @watch as the same directive', () => {
    for (const word of ['show', 'watch']) {
      const intent = classifyInput(`@${word} https://example.com`)
      expect(intent.kind, `@${word} must open`).toBe('open')
    }
  })

  it('reports a bad formula instead of quietly forwarding it', () => {
    // 显式指令里的拼写错误是用户自己该看见的问题，不是要交给
    // 模型的散文。解析器报的是 *为什么*，不是一句话，所以这些
    // 断言针对 reason；措辞归 `strings.ts`，由
    // 文案测试覆盖。
    const cases: [string, OpenError['kind']][] = [
      ['@opne https://example.com', 'unknownDirective'],
      ['@open', 'missingUrl'],
      ['@open not a url', 'firstArgumentNotUrl'],
      ['@open https://example.com pace=quick', 'paceInvalid'],
      ['@open https://example.com verify=sometimes', 'unknownKey'],
      ['@open https://example.com pin=maybe', 'pinInvalid'],
      ['@open https://example.com colour=red', 'unknownKey'],
      ['@open https://example.com --fast', 'notKeyValue'],
    ]
    for (const [input, expected] of cases) {
      const intent = classifyInput(input)
      expect(intent.kind, input).toBe('error')
      if (intent.kind === 'error') expect(intent.error.kind, input).toBe(expected)
    }
  })

  it('never forwards a malformed directive to the model', () => {
    // 格式错误的指令之所以自成一类 intent 而不是当成
    // prompt，原因在于：一旦当成 prompt，这条抱怨本身就会被原样透传，
    // 就像用户把它当指令打出来一样。
    for (const input of ['@opne https://example.com', '@open', '@open javascript:alert(1)']) {
      const intent = classifyInput(input)
      expect(intent.kind, input).toBe('error')
    }
  })

  it('shows the formula while the directive is still being typed', () => {
    // 输入打到一半还不算错，所以不能报成错误。
    // 单独的 `@open` 就不一样：指令是完整的，URL
    // 确实缺了，所以那种情况在上面被断言为错误。
    for (const partial of ['@', '@o', '@op', '@sho']) {
      const intent = classifyInput(partial)
      expect(intent.kind, partial).toBe('error')
      // 这个区分由错误自己承载，不由措辞承载——面板
      // 读这个标志来决定给提示还是告警。
      if (intent.kind === 'error') expect(isSoftOpenError(intent.error), partial).toBe(true)
    }
  })

  it('is not confused by an @ that is not a directive', () => {
    // 邮箱句柄、或者一个落单的 @，都算普通文本。
    for (const text of ['@', '@  spaced', 'mail me @ example.com', 'user@example.com']) {
      const parsed = parseOpenDirective(text)
      expect(parsed === undefined || parsed.error !== undefined, text).toBe(true)
    }
  })

  it('rejects a non-http scheme before anything opens a tab', () => {
    // `javascript:` 和 `file:` 绝不能到达 chrome.tabs。
    for (const bad of ['@open javascript:alert(1)', '@open file:///C:/windows', '@open chrome://settings']) {
      const intent = classifyInput(bad)
      expect(intent.kind, bad).toBe('error')
    }
  })
})
