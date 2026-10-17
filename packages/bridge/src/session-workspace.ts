/**
 * 给通过浏览器 bridge 创建的 session 做尽力而为的工作区分组。
 *
 * 这个包装层只碰一种请求：隐式的 `session.create`，它会带上浏览器分组的 workspace id。
 * 显式的 workspace 选择、以及其它所有 gateway 方法都原样透传——包括本模块为自己发起的
 * `workspace.create` 和 `workspace.rename` 调用，它们走同一个 API，绝不能被拦下来。
 *
 * 分组按设计就是尽力而为。失败时返回未分组的原始调用结果，而不是让这次提示失败，因为
 * 一个用户还能接着用的会话，比一份整齐的列表更值钱。
 *
 * @module dsh-browser-crossplatform/src/session-workspace
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'

type Warn = (message: string) => void

/**
 * 给浏览器对话分组起一个用户认得出的名字。
 *
 * 桌面端会照目录推导新工作区的标题，而 bridge 注册的目录叫 `browser-sessions`——于是这个
 * 分组就以那个名字出现。界面里没有任何地方能给工作区改名，也没有任何地方告诉用户这个分组
 * 存在，于是对话看起来就像丢了：它们其实都存着，只是存进了一个名字读起来像内部细节的
 * 分组。
 *
 * 标题是呈现层的事，所以这里的失败只上报、其余忽略。分组照旧生效，只是标签还是目录名。
 *
 * @param api - 注入的 gateway API 实现。
 * @param workspaceId - 要命名的工作区。
 * @param currentTitle - 桌面端报告的它的标题。
 * @param desiredTitle - 要应用的名字，空字符串表示不改。
 * @param warn - 用来记录“不影响分组”的失败的日志器。
 */
async function nameWorkspace(
  api: BrowserHostApi,
  workspaceId: string,
  currentTitle: unknown,
  desiredTitle: string,
  warn: Warn,
): Promise<void> {
  if (desiredTitle === '') return
  if (typeof currentTitle === 'string' && currentTitle === desiredTitle) return
  try {
    const response = await api.call({
      rpcId: randomUUID(),
      method: 'workspace.rename',
      payload: { workspaceId, title: desiredTitle },
      signal: new AbortController().signal,
    })
    if (response.ok) return
    // 用户已经建过同名工作区时，冲突就是预期内的。改名只是图个方便，
    // 所以争输了也不值得当成错误处理——不管哪种情况，
    // 对话都已经分好组了。
    warn(
      `browser bridge: could not name the session workspace "${desiredTitle}" `
      + `(${response.error.code}: ${response.error.message}); it keeps its directory name`,
    )
  } catch (error: unknown) {
    warn(`browser bridge: naming the session workspace failed: ${String(error)}`)
  }
}

/**
 * 给隐式 session 创建挂上一个专用 Workspace，同时不让分组变成 session 创建的前提。
 * 第一次隐式 create 会 mkdir 并注册配置的路径；这次的结果——包括失败——会在包装器的
 * 整个生命周期里缓存住。
 *
 * @param api - 注入的 gateway API 实现。
 * @param workspacePath - 专用目录，空字符串表示不这么做。
 * @param workspaceTitle - 分组的显示名，空字符串表示保留桌面端从目录推导出的名字。之所以
 *   需要一个标题，是因为推导出来的名字就是目录名，全新安装于是会显示
 *   "browser-sessions"——一个听起来很内部的标签，用户没理由打开它，也没法在界面上给它
 *   改名。
 * @param warn - 分组建不起来时调一次的日志器。
 * @returns 退出该行为时返回原来的 API，否则返回一个包装了 session 创建的 API。
 */
export function withSessionWorkspace(
  api: BrowserHostApi,
  workspacePath: string,
  workspaceTitle: string,
  warn: Warn,
): BrowserHostApi {
  if (workspacePath === '') return api

  let workspacePromise: Promise<string | undefined> | undefined
  const ensureWorkspace = (): Promise<string | undefined> => {
    if (workspacePromise !== undefined) return workspacePromise
    workspacePromise = (async () => {
      try {
        await mkdir(workspacePath, { recursive: true })
        const response = await api.call({
          rpcId: randomUUID(),
          method: 'workspace.create',
          payload: { path: workspacePath },
          signal: new AbortController().signal,
        })
        if (!response.ok) {
          warn(
            `browser bridge: workspace.create failed for "${workspacePath}" `
            + `(${response.error.code}: ${response.error.message}); sessions will remain ungrouped`,
          )
          return undefined
        }
        const value = response.value
        if (!isRecord(value) || !isRecord(value.workspace) || typeof value.workspace.workspaceId !== 'string') {
          warn(`browser bridge: workspace.create returned an invalid response; sessions will remain ungrouped`)
          return undefined
        }
        const workspaceId = value.workspace.workspaceId
        await nameWorkspace(api, workspaceId, value.workspace.title, workspaceTitle, warn)
        return workspaceId
      } catch (error: unknown) {
        warn(
          `browser bridge: could not prepare session workspace "${workspacePath}": `
          + `${String(error)}; sessions will remain ungrouped`,
        )
        return undefined
      }
    })()
    return workspacePromise
  }

  return {
    async call(call: HostRpcCall): Promise<HostRpcResult> {
      if (call.method !== 'session.create' || !isRecord(call.payload)) return api.call(call)
      if (call.payload.workspaceId !== undefined) return api.call(call)
      const workspaceId = await ensureWorkspace()
      if (workspaceId === undefined) return api.call(call)
      const payload: Record<string, unknown> = { ...call.payload, workspaceId }
      delete payload.cwd
      return api.call({ ...call, payload })
    },
    events: signal => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}
