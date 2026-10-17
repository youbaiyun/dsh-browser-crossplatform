/**
 * 本包自有的 invariant 伴生插件（package-owned），属于 `dsh-browser-crossplatform`。
 * @module dsh-browser-crossplatform/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-browser-crossplatform'

/** Cordis 伴生插件名。 */
export const name = 'bridge-browser-invariant'
/** 伴生插件要保留包所有权，就得先就绪的服务。 */
export const inject = ['invariants']

/**
 * 没有运行时 invariant：bridge 的连接注册表和待处理工具映射都是实例私有的（没有可供断言
 * 的已发布事件流），线上协议由 protocol.ts 固定，并由它的单元测试覆盖。这些工具只是普通的
 * ctx.tools 注册，由 dsh-tools 自己的 invariant 观察。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的 invariant 伴生插件。
 * @param ctx - 带着 invariant 服务的 Cordis 上下文。
 * @returns 初始化成功后返回已安装注册项的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
