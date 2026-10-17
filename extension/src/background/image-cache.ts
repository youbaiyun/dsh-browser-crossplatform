/**
 * 图像识别结果的会话内缓存，按图片身份索引。
 *
 * 缓存首先是为了保证一致性，其次才是省成本。
 * 识别不是确定性的：同一张图片问两次会得到两句不同的话，
 * 于是一个在三十行里摆着同一个 logo 的页面，就会攒出三十条互相矛盾的描述。
 * 按身份索引之后，答案属于图片本身，
 * 而不属于它被遇到过多少次。
 *
 * 失败也照记，只是每类失败的规则不一样：`blob:` URL 或超出预算的响应体
 * 在同一会话里不可能自己好起来，网络错误则可以。
 * 重试第一类，只是让每次快照白烧一次请求；
 * 重试第二类，恰恰就是恢复该有的样子。
 *
 * @module
 */

/**
 * 一条记住的答案，外加它是走哪种传输方式拿到的。
 *
 * 持久化存的就是这个结构，所以它保持成普通数据。
 */
export interface CachedDescription {
  desc: string
  /** `desktop` 或 `direct`：保留它，是为了让缓存下来的答案仍能归因开销。 */
  via: 'desktop' | 'direct' | ''
}

/** 所有值得跨过 service worker 重启留下来的东西。 */
export interface CacheSnapshot {
  descriptions: [string, CachedDescription][]
  failureCounts: [string, number][]
  permanentFailures: [string, string][]
}

/** 每次变更后调用一次，宿主据此把缓存写下去。 */
export type CacheListener = (cache: ImageCache) => void

/** 存下来的快照格式不对就整体丢掉，而不是恢复一半。 */
function readStringMap(value: unknown, guard: (entry: unknown) => boolean): [string, string][] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is [string, string] => (
    Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && typeof entry[1] === 'string' && guard(entry[1])
  ))
}

/** 描述和失败计数都设了上限的存储。 */
export class ImageCache {
  private readonly descriptions = new Map<string, CachedDescription>()
  private readonly failureCounts = new Map<string, number>()
  /**
   * 本会话里读不出来的身份，连同原因。
   *
   * 要留下的是原因，而不只是"读不了"这个事实：
   * 模型读到的文本会说清图片为什么不可用，
   * 而一句光秃秃的 "unavailable" 让它什么都做不了。
   */
  private readonly permanentFailures = new Map<string, string>()
  private readonly maxEntries: number
  private readonly maxAttempts: number
  private readonly onChanged: CacheListener | undefined

  /**
   * @param maxEntries - 淘汰最旧条目之前保留多少条描述。
   * @param maxAttempts - 每个身份能容忍几次瞬时失败。
   * @param onChanged - 每次变更后收到通知，用于持久化。
   */
  constructor(maxEntries = 200, maxAttempts = 2, onChanged?: CacheListener) {
    this.maxEntries = maxEntries
    this.maxAttempts = maxAttempts
    this.onChanged = onChanged
  }

  /**
   * 丢掉这种 map 里最旧的条目——它自己没有任何天然上限。
   *
   * `descriptions` 在写入处就卡住了上限，但两个失败 map 只有等同一身份后来成功
   * 才会缩小。一个碰上大量互不相同失败的 profile —— `blob:` URL、加载失败的图片、
   * 超出字节预算的响应体 —— 否则会为每个身份永远留着一条记录，
   * 而每条记录都属于每次变更时要写盘的那份负载，
   * 于是每改一次就把它们写一遍。
   *
   * @param entries - 要设上限的失败 map，就地修改。
   */
  private evictOldest(entries: Map<string, unknown>): void {
    while (entries.size > this.maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }

  /**
   * 把缓存摊成普通数据，交给比这个对象活得久的宿主。
   *
   * service worker 不是保存状态的地方：Chrome 可能在两次工具调用之间把它停掉，
   * 浏览器重启更是必然终结它。少了这一步，唯一能实打实缩短一次识别的杠杆
   * ——对同一张图片问两次——
   * 就只在 worker 恰好活着的时候管用。
   */
  snapshot(): CacheSnapshot {
    return {
      descriptions: [...this.descriptions],
      failureCounts: [...this.failureCounts],
      permanentFailures: [...this.permanentFailures],
    }
  }

  /**
   * 恢复一份快照，结构对不上的内容一概忽略。
   *
   * 存储区是跟别的代码共用的，还能跨版本升级活下来，
   * 所以快照可能已经过时、或者来自别处。恢复出半份可信的东西，比干脆不恢复更糟。
   *
   * @param value - 宿主存下来的任何东西。
   * @returns 确实恢复了内容时返回 true。
   */
  restore(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const record = value as Partial<CacheSnapshot>
    const descriptions = Array.isArray(record.descriptions)
      ? record.descriptions.filter((entry): entry is [string, CachedDescription] => (
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        && typeof entry[1] === 'object' && entry[1] !== null
        && typeof (entry[1] as CachedDescription).desc === 'string'
        && typeof (entry[1] as CachedDescription).via === 'string'
      ))
      : []
    const counts = Array.isArray(record.failureCounts)
      ? record.failureCounts.filter((entry): entry is [string, number] => (
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        && typeof entry[1] === 'number' && Number.isFinite(entry[1])
      ))
      : []
    const permanent = readStringMap(record.permanentFailures, (code) => code !== '')
    if (descriptions.length === 0 && counts.length === 0 && permanent.length === 0) return false
    for (const [identity, entry] of descriptions.slice(-this.maxEntries)) {
      this.descriptions.set(identity, entry)
    }
    for (const [identity, count] of counts) this.failureCounts.set(identity, count)
    for (const [identity, code] of permanent) this.permanentFailures.set(identity, code)
    // 引入这个上限之前写下来的快照可能超限，
    // 所以进来和出去两条路都要卡一遍。
    this.evictOldest(this.failureCounts)
    this.evictOldest(this.permanentFailures)
    return true
  }

  /**
   * 某张图片记住的描述。
   * @param identity - 图片身份（协议里的 `identity`）。
   * @returns 对应条目；还没识别过时返回 undefined。
   */
  get(identity: string): CachedDescription | undefined {
    return this.descriptions.get(identity)
  }

  /**
   * 记下一次成功的识别。
   *
   * 淘汰按插入顺序来，而不是按最近最少使用：
   * 这里读远多于写，每次读都重排一遍的代价
   * 会超过它偶尔省下的那次重新识别。
   *
   * @param identity - 图片身份。
   * @param desc - 单行描述。
   * @param via - 产出它的传输方式。
   */
  set(identity: string, desc: string, via: 'desktop' | 'direct' | '' = ''): void {
    this.descriptions.delete(identity)
    this.descriptions.set(identity, { desc, via })
    this.permanentFailures.delete(identity)
    this.failureCounts.delete(identity)
    while (this.descriptions.size > this.maxEntries) {
      const oldest = this.descriptions.keys().next()
      if (oldest.done === true) break
      this.descriptions.delete(oldest.value)
    }
    this.onChanged?.(this)
  }

  /**
   * 记下一次失败的识别。
   * @param identity - 图片身份。
   * @param permanent - 本会话里重试也好不了时为 true。
   * @param code - 失败原因，会进到模型读到的文本里。
   */
  noteFailure(identity: string, permanent: boolean, code = 'unavailable'): void {
    if (permanent) {
      this.permanentFailures.set(identity, code)
      this.evictOldest(this.permanentFailures)
      this.onChanged?.(this)
      return
    }
    this.failureCounts.set(identity, (this.failureCounts.get(identity) ?? 0) + 1)
    this.evictOldest(this.failureCounts)
    this.onChanged?.(this)
  }

  /**
   * 某张图片确实读不了时，给出原因。
   * @param identity - 图片身份。
   * @returns 失败代码；不是永久失败时返回 undefined。
   */
  failureOf(identity: string): string | undefined {
    return this.permanentFailures.get(identity)
  }

  /**
   * 值不值得再试一次识别。
   * @param identity - 图片身份。
   * @returns 图片已经有答案、或者根本拿不到答案时返回 false。
   */
  shouldAttempt(identity: string): boolean {
    if (this.descriptions.has(identity)) return false
    if (this.permanentFailures.has(identity)) return false
    return (this.failureCounts.get(identity) ?? 0) < this.maxAttempts
  }

  /** 已经记住的描述条数。 */
  get size(): number {
    return this.descriptions.size
  }

  /**
   * 供面板和诊断使用的计数。
   * @returns 已描述和永久不可用的数量。
   */
  stats(): { described: number; unavailable: number; retrying: number } {
    return {
      described: this.descriptions.size,
      unavailable: this.permanentFailures.size,
      retrying: this.failureCounts.size,
    }
  }

  /** 全部丢掉（换新页面、用户改了决定）。 */
  clear(): void {
    this.descriptions.clear()
    this.failureCounts.clear()
    this.permanentFailures.clear()
    this.onChanged?.(this)
  }
}
