/**
 * bridge bearer token 的一生：生成、常量时间校验，以及在 dsh home 目录下落成文件。
 *
 * 这个 token 用来让浏览器扩展通过 bridge WebSocket 的认证。它**不是** /api 的信任围栏
 * （那道围栏保持不动），而是 bridge 这条路径自己的认证，因为 bridge 路由按设计本来就在
 * 那道围栏之外。
 *
 * @module
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** 持久化 token 在 dsh home 里的文件名。 */
export const TOKEN_FILE_NAME = 'ext-bridge-token'

/**
 * 生成一个新的小写十六进制 token。
 * @param bytes - 熵字节数；默认为 DEFAULT_TOKEN_BYTES（256 位）。
 * @returns 十六进制的 token 字符串。
 */
export function generateToken(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * 常量时间比较 token。长度不等就快速失败（被比较的那段前缀上仍然是常量时间）——长度不对
 * 的 token 永远过不了校验。
 * @param expected - 配置里的 token。
 * @param actual - 客户端出示的 token。
 * @returns 只有两者等长、都是 hex、且逐字节相等时才为 true。
 */
export function verifyToken(expected: string, actual: string): boolean {
  // 按 UTF-8 字节比较，不做 hex 解码：hex 解码会悄悄把非 hex 的已配置 token 截断
  //（Buffer.from('fixed-token','hex') 得到空缓冲区），还会把 'deadbeef-team' 压成
  // 'deadbeef'，把 token 的熵丢掉。
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/**
 * 持久化的 token 文件在 dsh home 下的路径。
 * @returns 形如 `~/.dsh/ext-bridge-token` 的绝对路径。
 */
export function tokenFilePath(): string {
  return dshHomePath(TOKEN_FILE_NAME)
}

/**
 * 读取已持久化的 token；不存在或读不到时返回 undefined。
 * @param file - token 文件路径。
 * @returns 已存储的 hex token（去除首尾空白）。
 */
export async function readTokenFile(file: string = tokenFilePath()): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/**
 * 以 0600 权限把 token 原子地存下来（临时文件 + rename）。
 * @param token - 要持久化的 hex token。
 * @param file - token 文件路径。
 */
export async function writeTokenFile(token: string, file: string = tokenFilePath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${token}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, file)
}

/**
 * 解析 bridge token：显式配置的 token 优先；没有就复用已持久化的文件，再不然就生成一个
 * 全新的 token 持久化下去。
 * @param configured - 来自插件配置的 token，或 undefined。
 * @param file - token 文件路径（可注入，便于测试）。
 * @returns `{ token, file, generated }`，其中 `generated` 记录这次是不是新铸了一个 token。
 */
export async function resolveToken(
  configured: string | undefined,
  file: string = tokenFilePath(),
): Promise<{ token: string; file: string; generated: boolean }> {
  if (configured !== undefined && configured.length > 0) {
    return { token: configured, file, generated: false }
  }
  const persisted = await readTokenFile(file)
  if (persisted !== undefined && persisted.length > 0) return { token: persisted, file, generated: false }
  const token = generateToken()
  await writeTokenFile(token, file)
  return { token, file, generated: true }
}
