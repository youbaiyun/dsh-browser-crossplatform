import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // worker 启动的规格单独跑时每个约 370ms，而这套件会并行跑每个文件；
    // 在一台有负载的机器上，默认的五秒对其中最慢的那个太紧了。
    // 真正卡住的测试仍然会失败，只是更晚一些。
    testTimeout: 15_000,
    setupFiles: ['tests/setup.ts'],
  },
})
