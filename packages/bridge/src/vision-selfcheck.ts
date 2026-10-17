/**
 * 启动时检查成本开关到底生效没有。
 *
 * 忽略 `thinking: {type: 'disabled'}` 的提供方照样作答，于是一切看起来都没问题，而每张
 * 图片的开销却是图片本身的数倍——纯感知任务上，thinking token 才是账单的大头。请求体证明
 * 不了这个开关被遵守，`usage` 可以。
 *
 * 这段检查只在后台跑一次，而且只发警告。提供方什么都不上报的部署就保持沉默，而不是虚报
 * 狼来了：零意味着“就本次响应而言没有计费”，并不等于证据。
 *
 * @module
 */

import type { VisionClient } from './vision.ts'

/** 运行这次探测，并报告被静默忽略的开关。 */
export function checkThinkingIsOff(vision: VisionClient, warn: (message: string) => void): void {
  void vision.probe().then((probe) => {
    if (!probe.ok) {
      warn(`browser bridge: vision self-check could not run (${probe.message}); the thinking switch is unverified`)
      return
    }
    if (probe.reasoningTokens > 0) {
      warn(
        `browser bridge: visionThinking is "off" but the provider billed ${String(probe.reasoningTokens)} reasoning tokens. `
        + 'The switch is being ignored, so each image costs more than the image itself. '
        + 'Set visionThinking to "low" if that is intended, or use an endpoint that honours the switch.',
      )
    }
  }).catch(() => {
    // 一项诊断绝不能有本事把启动弄坏。
  })
}
