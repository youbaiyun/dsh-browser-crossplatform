import { defineConfig } from 'vitest/config'

/** 针对已发布的 DeepSeek Harness 包运行的独立测试运行器。 */
export default defineConfig({
  test: {
      // e2e 套件会在一个 hook 里启动真实浏览器和真实 bridge。Vitest 把 hook
      // 和测试分开计时，而它默认的 10s 正是第一次 CI 跑失败的地方，
      // 尽管那个套件里每个测试本来就允许 120s。
      hookTimeout: 120_000,
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup-invariant.ts'],
  },
})
