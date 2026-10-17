/**
 * 加载并执行这个包的不变量伴生文件，好让覆盖率门禁能测到它（host SDK 会通过
 * scripts/test-invariants.ts 对每个包做这件事）。这个桩注册表会直接运行
 * installer，与真实不变量服务的行为一致。
 */
import { apply } from '../src/invariant.ts'

void apply({
  invariants: {
    register: (_name: string, install: () => void) => {
      install()
      return () => {}
    },
  },
} as never)
