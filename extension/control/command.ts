/**
 * 底部输入框的输入解析。
 *
 * 同一行输入里，输入框要接两种完全不同的东西：
 *
 *  - **浏览器命令**，由扩展自己执行（`browser_click
 *    {"index":3}`），以及
 *  - **给模型的指令**，转发给桌面端 dsh 应用。
 *
 * 两者一旦搞混，就是这里唯一危险的失败方式，所以规则故意定得很保守：
 * 一行里点名了真实工具、或者本身就是一个 URL，才算命令。
 * 其余一切都是给模型的提示词。
 *
 * @module
 */

import { BROWSER_TOOL_NAMES as TOOL_NAMES } from '../src/background/tools.ts'

/**
 * 工具集，重新导出给输入框用。
 *
 * 这份列表是 import 来的，不是照抄一份——这是有意的：后台会拒掉任何名字不在
 * 它自己注册表里的命令，这里再抄一份，就可能向用户给出一个注定会失败的
 * 命令。
 */
export const BROWSER_TOOL_NAMES: readonly string[] = TOOL_NAMES

/** 输入框可以派发的一个工具名。 */
export type BrowserToolName = string

/**
 * 用户真会敲的裸词，对应到工具名。
 *
 * 只给无歧义的读取/定位类动作设了别名。这里除了 `goto`/`open`，没有别的会改
 * 页面状态，而这两个本来也都需要一个 URL。
 */
const SHORTHANDS: Readonly<Record<string, BrowserToolName>> = {
  snapshot: 'browser_snapshot',
  read: 'browser_get_text',
  text: 'browser_get_text',
  click: 'browser_click',
  type: 'browser_type',
  fill: 'browser_type',
  press: 'browser_press',
  key: 'browser_press',
  scroll: 'browser_scroll',
  wait: 'browser_wait',
  tabs: 'browser_list_tabs',
  back: 'browser_back',
  forward: 'browser_forward',
  reload: 'browser_reload',
}

export type InputIntent =
  /** 用户敲了一条浏览器命令；在这里执行它。 */
  | { kind: 'command'; name: BrowserToolName; args: Record<string, unknown>; echo: string }
  /**
   * 用户明确说了“打开这个给我看”。
   *
   * 和命令不同，这不算一次工具调用：扩展自己开标签页、带到前台、绑成受控
   * 标签页、再打开面板，就按这个顺序来，模型完全不参与。正因如此，“这样我
   * 就能看着它做”是一条保证，而不是模型可以顺手跳过的请求。
   */
  | { kind: 'open'; url: string; options: OpenOptions; echo: string }
  /** 用户敲了一条指令；把它转发给模型。 */
  | { kind: 'prompt'; text: string }
  /**
   * 用户敲的东西看起来像 @ 指令，但没法用。
   *
   * 和 `prompt` 分开，是为了让这条消息永远不发给模型：它只发生在用户和
   * 解析器之间，措辞随面板语言走。以前它是一个带句子的 `prompt`，于是打错
   * 一个字，这条抱怨就会被当成指令原样传上去。
   */
  | { kind: 'error'; error: OpenError }

/** 一次 `@open` 跑起来该是什么样。 */
export interface OpenOptions {
  /** 各步骤之间的延迟，好让人跟得上正在发生什么。 */
  pace: 'fast' | 'normal' | 'slow'
  /** 打开的标签页是否就交给浏览器工具去操作。 */
  pin: boolean
}

/**
 * 一条 `@open` 指令为什么用不了。
 *
 * 是一个 code 加上它的组成部分，而不是一个句子。句子归语言表（`strings.ts`），
 * 因为选了英文的用户不该收到中文答复——以前恰好就是这样：解析器自己拼消息
 * 那段时间，不管面板是什么语言，都有九条消息是中文的。
 *
 * 返回原因而不是措辞，也让这个模块保持为输入的纯函数，所以它不用 DOM
 * 就能测。
 */
export type OpenError =
  | { kind: 'directiveFormat'; known: string; soft: true }
  | { kind: 'unknownDirective'; directive: string; known: string }
  | { kind: 'missingUrl'; directive: string }
  | { kind: 'firstArgumentNotUrl'; directive: string; received: string }
  | { kind: 'notKeyValue'; pair: string }
  | { kind: 'paceInvalid'; allowed: string; received: string }
  | { kind: 'pinInvalid'; received: string }
  | { kind: 'unknownKey'; key: string }
  | { kind: 'unparsable' }

/**
 * 一条指令错误值不值得打断用户。
 *
 * `directiveFormat` 在一条正确的指令还没敲完时就会触发——用户刚写完 `@op`，
 * 后面还在输入——所以它只是安静地提示一下格式长什么样。其他一切都属于用户
 * 需要看到的错误。
 *
 * 这件事放在错误自己身上，作为一个属性，而不是从消息文本里猜。面板以前
 * 靠判断字符串是不是以某个中文词开头，文本一翻译，这个区分就没了：敲到一半
 * 的指令在英文下被当成硬错误显示，而浏览器反倒是对的。
 * 对的。
 */
export const isSoftOpenError = (error: OpenError): boolean =>
  error.kind === 'directiveFormat'

/** 按 pace 分档的 `@open` 各步骤间暂停毫秒数。 */
export const OPEN_PACE_MS: Record<OpenOptions['pace'], number> = {
  fast: 0,
  normal: 350,
  slow: 1_200,
}

/** formula 的默认选项，某个键省略时用这些。 */
export const OPEN_DEFAULTS: OpenOptions = { pace: 'normal', pin: true }

/** 这条指令可以接受的写法。 */
const OPEN_DIRECTIVES = new Set(['open', 'show', 'watch'])

const PACES = new Set<OpenOptions['pace']>(['fast', 'normal', 'slow'])

/** 布尔型 formula 键的真/假取值词。 */
function parseToggle(raw: string): boolean | undefined {
  if (['on', 'true', 'yes', '1'].includes(raw.toLowerCase())) return true
  if (['off', 'false', 'no', '0'].includes(raw.toLowerCase())) return false
  return undefined
}

/**
 * 解析 `@open <url> [key=value …]`。
 *
 * `@open https://store.steampowered.com pace=slow pin=off`
 *
 * 文本根本不是 `@` 指令，就返回 `undefined`；是指令但没法用，就返回
 * `error`——显式指令里的笔误应该报出来，而不是当成大白话悄悄转给模型。
 */
export function parseOpenDirective(text: string): { directive: string; url?: string; options?: OpenOptions; error?: OpenError } | undefined {
  if (!text.startsWith('@')) return undefined
  const body = text.slice(1).trim()
  const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body)
  const directive = (match?.[1] ?? '').toLowerCase()
  const rest = (match?.[2] ?? '').trim()
  // 这份列表用逗号加空格拼，而不是用顿号：它只是一串名字，要塞进不管哪种
  // 语言写成的句子里，而中文顿号放在英文里读着就像个错误。
  const known = [...OPEN_DIRECTIVES].map((name) => `@${name}`).join(', ')

  // 一个词只要是某条真实指令的前缀，就说明还在输入中，于是给格式提示而不是
  // 报错。一条*完整*指令却没有参数是另一回事——URL 是真缺了——会落到下面的
  // 错误分支。也正因为这个区分，这里查的是前缀，而不是“只含字母”。
  if (!OPEN_DIRECTIVES.has(directive)) {
    if ([...OPEN_DIRECTIVES].some((name) => name.startsWith(directive))) {
      return { directive, error: { kind: 'directiveFormat', known, soft: true } }
    }
    // 未知指令几乎都是某条已知指令的笔误，所以把已知指令列出来，而不是去猜
    // 用户想说什么。
    return { directive, error: { kind: 'unknownDirective', directive, known } }
  }

  const [first, ...pairs] = tokenize(rest)
  if (first === undefined) {
    return { directive, error: { kind: 'missingUrl', directive } }
  }
  // 开头的 URL 后面可以跟 key=value 对；别的写法都是笔误。
  const url = parseUrlLike(first)
  if (url === undefined) {
    return { directive, error: { kind: 'firstArgumentNotUrl', directive, received: first } }
  }

  const options: OpenOptions = { ...OPEN_DEFAULTS }
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      return { directive, url, error: { kind: 'notKeyValue', pair } }
    }
    const key = pair.slice(0, separator).toLowerCase()
    const value = pair.slice(separator + 1)
    switch (key) {
      case 'pace': {
        if (!PACES.has(value as OpenOptions['pace'])) {
          return { directive, url, error: { kind: 'paceInvalid', allowed: [...PACES].join(' / '), received: value } }
        }
        options.pace = value as OpenOptions['pace']
        break
      }
      case 'pin': {
        const toggle = parseToggle(value)
        if (toggle === undefined) return { directive, url, error: { kind: 'pinInvalid', received: value } }
        options.pin = toggle
        break
      }
      default:
        return { directive, url, error: { kind: 'unknownKey', key } }
    }
  }

  return { directive, url, options }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolName(value: string): boolean {
  return BROWSER_TOOL_NAMES.includes(value)
}

/** 一个完整的 http(s) URL，可以不带 scheme。 */
export function parseUrlLike(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return undefined
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    // 不带点的裸词，更可能是普通文字而不是主机名。真的只有单段的名字，
    // 在这里显式放行。
    if (!/^https?:\/\//i.test(trimmed) && !isUsableHostname(url.hostname)) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function isUsableHostname(hostname: string): boolean {
  return hostname.includes('.')
    || hostname === 'localhost'
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * `key=value` 对，JSON 之外的另一条路。
 *
 * `click index=3 frame=1` 比 `{"index":3,"frame":1}` 好敲，而且能按 JSON
 * 解析的值（数字、布尔、带引号的字符串）会保住自己的类型，于是 `index=3`
 * 就是工具 schema 要的那个数字。双引号里的值可以带空格，这才让
 * `type text="hello world"` 能用。
 */
function parseAssignments(tokens: readonly string[]): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {}
  for (const token of tokens) {
    const separator = token.indexOf('=')
    if (separator <= 0) return undefined
    const key = token.slice(0, separator)
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) return undefined
    const raw = token.slice(separator + 1)
    args[key] = parseAssignmentValue(raw)
  }
  return Object.keys(args).length === 0 ? undefined : args
}

/** 赋值右侧的值：能按 JSON 解析就用 JSON，否则就用字面文本。 */
function parseAssignmentValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * 切分参数列表，同时让双引号里的内容不被打散。
 *
 * 直接 `split(/\s+/)` 会把 `text="hello world"` 切成两个 token，这个参数
 * 就悄悄丢了，所以这里必须认带引号的写法。
 */
function tokenize(rest: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const char of rest) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/**
 * 补上某个工具显然会隐含需要的参数。
 *
 * 这些只是顺手帮忙，不是策略：后台照样会校验每一个参数，碰到它不认识的
 * 任何东西一律按失败关闭。
 */
function withImpliedArgs(name: BrowserToolName, args: Record<string, unknown>, url: string | undefined): Record<string, unknown> {
  if (name === 'browser_navigate' || name === 'browser_open_tab') {
    if (typeof args.url !== 'string' && url !== undefined) return { ...args, url }
  }
  if (name === 'browser_scroll' && typeof args.direction !== 'string' && args.direction === undefined) {
    return { ...args, direction: 'down' }
  }
  if (name === 'browser_snapshot' && args.delta === undefined && args.delta === 'true') {
    return { ...args, delta: true }
  }
  return args
}

/**
 * 判断用户想干什么。
 *
 * `browser_click {"index":3}`、`click index=3` 和 `https://example.com` 都是
 * 命令。`总结这个页面` 以及别的一切都是提示词。
 */
export function classifyInput(value: string): InputIntent {
  const text = value.trim()
  if (text === '') return { kind: 'prompt', text: '' }

  // `@` 指令是显式的，所以要抢在任何可能把它当大白话的解析之前处理。
  // 格式出错的指令仍然是一条带着自己错误的提示词，这样面板能报出这个笔误，
  // 而不是让模型悄悄收到它。
  const directive = parseOpenDirective(text)
  if (directive !== undefined) {
    const echo = text.replace(/\s+/g, ' ')
    if (directive.error !== undefined) return { kind: 'error', error: directive.error }
    if (directive.url === undefined || directive.options === undefined) {
      return { kind: 'error', error: { kind: 'unparsable' } }
    }
    return { kind: 'open', url: directive.url, options: directive.options, echo }
  }

  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/.exec(text)
  const head = match?.[1] ?? ''
  const rest = (match?.[2] ?? '').trim()

  const explicit = isToolName(head) ? head : SHORTHANDS[head.toLowerCase()]
  if (explicit !== undefined) {
    const parsed = parseCommandArguments(rest)
    if (parsed !== undefined) {
      return {
        kind: 'command',
        name: explicit,
        args: withImpliedArgs(explicit, parsed.args, parsed.url),
        echo: text.replace(/\s+/g, ' '),
      }
    }
    // `browser_*` 这个名字即使配上看不懂的参数也是无歧义的：后台会校验这次
    // 调用并按失败关闭处理，这比把一条格式错误的命令悄悄转给模型要好。
    if (isToolName(head)) return { kind: 'command', name: explicit, args: {}, echo: text.replace(/\s+/g, ' ') }
    // 简写只是一个普通的英文单词。“read the docs please” 是大白话，所以一个
    // 带着我们读不懂的参数的简写仍然算提示词。
  }

  // 光秃秃一个 URL，或者一个带点的单段主机名，都表示“去这里”。
  const url = parseUrlLike(text)
  if (url !== undefined) {
    return { kind: 'command', name: 'browser_navigate', args: { url }, echo: text }
  }

  return { kind: 'prompt', text }
}

interface ParsedArguments {
  args: Record<string, unknown>
  /** 参数里点名的 URL（如果有），给需要单独拿到它的工具用。 */
  url: string | undefined
}

function parseCommandArguments(rest: string): ParsedArguments | undefined {
  if (rest === '') return { args: {}, url: undefined }

  if (rest.startsWith('{')) {
    try {
      const value = JSON.parse(rest) as unknown
      if (!isRecord(value)) return undefined
      return { args: value, url: typeof value.url === 'string' ? value.url : undefined }
    } catch {
      return undefined
    }
  }

  const tokens = tokenize(rest)
  const head = tokens[0] ?? ''

  // 开头的 URL，后面可以跟 `key=value` 对。
  const url = parseUrlLike(head)
  if (url !== undefined) {
    const tail = tokens.slice(1)
    const extra = tail.length === 0 ? {} : parseAssignments(tail) ?? {}
    return { args: { ...extra, url }, url }
  }

  // 单独一个方向词是 scroll 的参数，不是一次赋值。
  if (tokens.length === 1 && /^[a-z]+$/i.test(head)) {
    return { args: { direction: head.toLowerCase() }, url: undefined }
  }

  const assignments = parseAssignments(tokens)
  return assignments === undefined ? undefined : { args: assignments, url: undefined }
}

/** 一次调用在运行之前是否需要显式的确认参数。 */
export function requiresConfirmArgument(name: string): boolean {
  return name === 'browser_close_tab'
}
