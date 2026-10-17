/**
 * 在 dsh home 下按文件删掉某个 session 的持久化存储。
 *
 * gateway 没有暴露 session.delete，bridge 就自己来：本模块先拿到独占写所有权，归档该
 * session，再删掉它的持久化数据，同时留下内核锁的路径名。session id 按持久化形态校验，
 * 只删 sessions 根目录往下两层、且目录名完全相符的目录里的数据，而且在碰磁盘之前就把
 * 仍在运行的 session 拒掉。
 *
 * @module dsh-browser-crossplatform/src/session-purge
 */

import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/** 暴露给面板的稳定失败码。开放集合：调用方必须能容忍以后新增的。 */
export type SessionPurgeErrorCode = 'not-found' | 'running' | 'invalid-id' | 'internal'

/** {@link purgeSessionFiles} 抛出的错误，服务端会把它转成 wire 错误。 */
export class SessionPurgeError extends Error {
  constructor(
    readonly code: SessionPurgeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionPurgeError'
  }
}

/** 持久化的 session id 是 `session-` 加一个小写 UUID。 */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
/** POSIX flock 挂在这个 inode 上；把它 unlink 掉就等于破坏了互斥。 */
const SESSION_LOCK_FILENAME = 'session.lock'

/** 清理时要从插件拿到的依赖。 */
export interface SessionPurgeDeps {
  /** dsh 的 sessions 根目录（`dshHomePath('sessions')`）。 */
  sessionsRoot: string
  /** 当前正在运行的 session id；清理其中任何一个都会被拒绝。 */
  runningSessionIds: ReadonlySet<string>
  /**
   * 取得运行时的独占写所有权（含它的内核锁）。返回的句柄要一直拿在手里，直到删除结束。
   * 开个读句柄、看一眼锁文件在不在、或者只查 Agent 状态，都不构成互斥：空闲的 Agent 和
   * 其它进程同样可能握着这份日志。
   */
  acquireOwnership(sessionId: string): Promise<{ close(): Promise<void> }>
  /** 在持久化 session 还在、且独占所有权仍握在手里的时候做归档。 */
  archiveSession(sessionId: string): Promise<void>
}

/**
 * 按持久化形态校验一个 session id。在任何文件系统调用看到它之前，就把可能逃出 sessions
 * 根目录的输入（分隔符、点段）统统拒掉。
 * @param sessionId - 来自面板的不可信 id。
 * @returns 形态合法时返回该 id。
 * @throws 否则抛出 code 为 `invalid-id` 的 SessionPurgeError。
 */
export function assertPurgeableSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionPurgeError('invalid-id', `session id "${sessionId}" does not match the persisted shape`)
  }
  return sessionId
}

/**
 * 永久删掉某个 session 的数据，但留下它的目录和锁 inode。
 * 跨工作区出现、含义不明的重复 session 标识，运行时会拒掉。
 * @param deps - 根目录与运行中集合等输入。
 * @param sessionId - 已校验的 session id。
 * @returns 无返回值；被拒绝或失败时抛出 {@link SessionPurgeError}。
 */
export async function purgeSessionFiles(deps: SessionPurgeDeps, sessionId: string): Promise<void> {
  assertPurgeableSessionId(sessionId)
  if (deps.runningSessionIds.has(sessionId)) {
    throw new SessionPurgeError('running', 'refusing to purge a running session; cancel it first')
  }

  let workspaces: string[]
  try {
    workspaces = await readdir(deps.sessionsRoot, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  } catch (error: unknown) {
    throw new SessionPurgeError('internal', `could not read the sessions root "${deps.sessionsRoot}": ${String(error)}`)
  }

  const targets: string[] = []
  for (const workspace of workspaces) {
    // 这里用 path.join 是安全的：上面的 id 模式已经排除了分隔符和点段，
    // 拼出来的片段逃不出工作区目录。
    const candidate = path.join(deps.sessionsRoot, workspace, sessionId)
    try {
      if (!(await lstat(candidate)).isDirectory()) continue
      const entries = await readdir(candidate)
      if (entries.some(entry => entry !== SESSION_LOCK_FILENAME)) targets.push(candidate)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SessionPurgeError('internal', `could not inspect "${candidate}": ${String(error)}`, { cause: error })
      }
    }
  }

  if (targets.length === 0) {
    throw new SessionPurgeError('not-found', `no durable storage found for session "${sessionId}"`)
  }
  let ownership: { close(): Promise<void> }
  try {
    ownership = await deps.acquireOwnership(sessionId)
  } catch (error: unknown) {
    // 运行时可能被加载了多份副本，所以匹配用公开的错误身份，
    // 不依赖私有的 JSONL 锁实现。
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new SessionPurgeError(
        'running',
        'session is still owned by a runtime; release the session or restart that runtime, then retry deletion',
      )
    }
    throw new SessionPurgeError('internal', `could not acquire exclusive session ownership: ${String(error)}`)
  }
  let failure: unknown
  let archived = false
  try {
    // 公开的 archive API 会检查存在性。删完之后再调它，只有当它的头部缓存里
    // 已经知道这个 id 时，才会意外地成功。
    await deps.archiveSession(sessionId)
    archived = true
    for (const target of targets) {
      if (!(await lstat(target)).isDirectory()) throw new Error(`session directory changed: ${target}`)
      // 打开写入之后再扫一遍：打开一份旧日志可能会生成 V3。
      for (const entry of await readdir(target)) {
        if (entry === SESSION_LOCK_FILENAME) continue
        await rm(path.join(target, entry), { recursive: true, force: true })
      }
    }
  } catch (error: unknown) {
    failure = new SessionPurgeError('internal', archived
      ? `session was archived, but durable cleanup failed: ${String(error)}`
      : `could not archive session; durable data was preserved: ${String(error)}`, { cause: error })
  } finally {
    try {
      await ownership.close()
    } catch (error: unknown) {
      failure = failure === undefined
        ? new SessionPurgeError('internal', `session was archived and cleared, but ownership release failed: ${String(error)}`, { cause: error })
        : new SessionPurgeError('internal', `${String(failure)}; ownership release also failed: ${String(error)}`, {
          cause: new AggregateError([failure, error], 'session purge and ownership release failed'),
        })
    }
  }
  if (failure !== undefined) throw failure
}
