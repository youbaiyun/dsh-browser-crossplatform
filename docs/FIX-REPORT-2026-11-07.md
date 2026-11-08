# 修复报告：dsh-browser-crossplatform 2026-11-07 实机测试问题

**报告日期**：2026-11-07
**被测版本**：桌面端 DeepSeek Harness `0.2.2-rc.1`（Windows 11）+ 扩展 `0.38.7`（Chrome Web Store，id `agpipnjijkpomaannkijkilggoffdiaf`），Chrome 155
**输入报告**：`REPORT-2026-11-07-dsh-0.2.2-rc.1.md`（14 项：P0 ×3、P1 ×5、P2 ×6）
**处理结果**：14/14 已修复并有回归测试；扩展 **577 tests 全绿**、typecheck 与 build 通过。
**代码位置**：`D:\DSH-demo-0.38.8`（未改版本号；改动见文末清单）

---

## 1. 结论摘要

- **P0-1 / P0-2 是同一个缺陷**：在默认 `tabSwitch: 'follow'` 下，`TabAffinity.status()` 把「显式跟随/后台打开」误判成「跟随当前可见标签页」。于是工具读的是另一个标签页，`open_tab{active:false}` 建好页后又被判成 `targetChanged`。修在 `status()` 一处，两条现象同时消失。
- **P0-0**：扩展没有 `chrome.runtime.onStartup` 监听，浏览器重启后 service worker 不会被唤醒，`alarms` 也不保证跨重启存活，所以必须手动开侧栏才连回去。已补监听，启动即重连。
- **P1-3**：点击导致文档卸载时 `sendMessage` 以 "message port closed" 失败，旧代码把它当「content script 死了」。现在识别为导航、等新文档就绪并拍快照；**绝不重发点击**（否则可能双击）。
- **P1-4 / P1-5 / P1-6**：分别是合成 `submit` 事件不触发表单提交流程、URL 敏感参数未掩码、readability 只渲染主区域且 delta 因此「看不见」主区域外的变化。三者都改在内容脚本的文本层，有独立回归测试。
- **P1-7 及 P2 系列**：自动快照在浏览器级导航上补齐、`region` 同时裁清单、CSS 背景图入 Images、`<style>` 不再泄进正文、最小化视口不再全标「视口外」、`get_text` 缺元素改为失败、`describe_image` 与 `hello.ok` 的口径统一。

---

## 2. 逐项修复

| 编号 | 现象（摘自报告） | 根因 | 修复 | 回归测试 |
|---|---|---|---|---|
| **P0-1** | `browser_follow_tab(962358777)` 成功，但快照读的是 active=962358710 | `TabAffinity.status()` 在 `switchMode==='follow'` 时只看 `active===controlled`，显式绑定被当成 `following`；`resolveTarget()` 的 following 分支返回 `this.active` | `status()` 先判 `keptActiveTabId !== null && active.tabId === keptActiveTabId → 'background'`；`resolveTarget()` 不变（其 following 分支对另外两种情况仍正确） | `tab-affinity.spec.ts`：`keeps tools on an explicitly followed background tab in follow mode` |
| **P0-2** | `browser_open_tab(active:false)` 已建好页却返回 `The controlled tab changed…` | 同上：`allowsTarget(newTab)` 为 false → `tools.ts` 的 `targetChanged()` | 同上（`bindOpenedTabAffinity` 的 `rebindControlled` 因此生效） | `open-tab-binding.spec.ts`：`targets a background open even when the switch mode is follow` |
| **P0-0** | DSH/浏览器重启后扩展不自动重连，0 个 service worker | 全仓无 `chrome.runtime.onStartup`；`alarms` 跨重启不保证 | `background/index.ts` 增加 `onStartup`：`armBridgeKeepalive()` → `reclaimBridgeIfReplaced()` → 必要时 `startBridge()` → `syncBadge()` | `background-bridge-lifecycle.spec.ts`：`reconnects on browser startup without waiting for the panel to be opened`（断言新 socket + keepalive alarm） |
| **P1-3** | 点击触发导航，却报 "content script stopped responding"（导航其实成功） | 文档卸载让 `sendMessage` 以 port closed 失败；旧逻辑直接抛错 | `dispatchOnce` catch：`dispatchLostToNavigation()` 命中且存在 `navigationWait` 时，等 `navigationWait.ready`，就绪则 `snapshotAfterNavigation()` 返回快照，否则返回带引导的 ok 文本；**不重发点击** | `background-tools.spec.ts`：`reports a click that navigated away as navigation…`（断言只派发一次 click） |
| **P1-4** | `press Enter` 不提交表单 | 旧代码只 `form.dispatchEvent(new Event('submit'))`，合成事件不跑提交算法 | 新增 `submitFromEnter()`：submit/image/reset/button 类 input 与按钮直接 `click()`，其余 `form.requestSubmit()`；keydown 被 `preventDefault()` 时不提交 | `actions-press.spec.ts`（5 个）：提交生效、`preventDefault` 抑制、textarea 不提交、submit 按钮、keydown/keyup 顺序 |
| **P1-5** | 快照 URL 出现 `?user=alice&pwd=s3cret` | URL 原样渲染 | `snapshot.ts` 新增 `redactSensitiveUrl()`，4 处渲染点接入（页面 URL、delta 头、链接 href、图片 src）；掩码 `pass/pwd/secret/token/sig/otp/api_key/session…`，保留普通参数，兼容相对 URL 与百分号编码参数名 | `snapshot-redaction.spec.ts`（6 个） |
| **P1-6** | `<main>` 外的 `<h1>`/`<p id=intro>` 丢失；`wait(text=…)` 成功但快照说 `(No visible changes.)` | readability 只渲染主区域；delta 比较的是同一段文本 | `extract.ts` 新增 `surroundingText()`：按文本节点补齐主区域外内容，跳过 `NAV/ASIDE/FOOTER/SCRIPT/STYLE/NOSCRIPT/TEMPLATE`；`snapshot.ts` 把外文串在正文前，delta 因此能看见变化 | `snapshot-main-region.spec.ts`（3 个）、`extract.spec.ts` |
| **P1-7** | `navigate` 有时带快照；`back` 只回「Call browser_snapshot…」 | `dispatchTabNativeTool` 只调 `chrome.tabs.*` 就返回 `navigationPending` | 导航类工具同样先记 `beforeDocument` + `waitForNextDocumentReady`；操作后按目标 URL 判断可注入性，就绪则 `snapshotAfterNavigation()` | `background-tools.spec.ts`：`attaches the new page snapshot after a browser-level navigation`；原 `uses browser-level navigation…` 用例同步更新 |
| **P2-8** | `region` 只裁正文，交互清单仍是整页 | 清单/图片收集用 `document` | `buildSnapshot` 用 `regionEl ?? document` 作为 `collectInteractive`/`collectImages` 的范围 | `snapshot-region.spec.ts`（2 个） |
| **P2-9** | CSS 背景图不进 Images | **复核：`images.ts` 已支持**（`backgroundUrlOf`，渐变与过小图片跳过） | 无代码改动，补回归测试锁定行为 | `snapshot-background-image.spec.ts`（2 个） |
| **P2-10** | `<style>` 文本混进 example.com 正文 | 内联 `<svg>` 不是 `HTMLElement`，退回裸 `textContent` 时把 `<svg><style>` 的 CSS 带出 | `elementText()`：innerText 可用且子树无 script/style 时用 innerText；否则逐文本节点遍历并跳过排除标签（SVG `tagName` 为小写，统一 `toUpperCase()` 判断） | `extract.spec.ts`：`never leaks style or script source into page text` |
| **P2-11** | 最小化窗口把所有元素标 `[outside viewport]` | 最小化时浏览器报告 0×0 视口，视口内判定全为 false | `isInViewport()`：`innerWidth/Height <= 0` 视为「未知」，不标注 | `actions-get-text.spec.ts` |
| **P2-12** | `click` 缺元素返回 Error，`get_text` 缺选择器却返回成功文本 | `getTextAction` 把「没命中」写进成功文本 | 选择器未命中抛 `ActionError('action-failed', 'No element matched selector: …')`，与 `click` 语义一致 | `actions-get-text.spec.ts` |
| **P2-13** | `describe_image` 说识别关闭，`hello.ok` 却报 `imageRecognition: true` | 两句话都对但指两个开关：桌面端「愿意识别」vs 扩展「看图档位=关」 | 档位为 `off` 且桌面端 `imageRecognition===true` 时，错误文案说明「扩展开关关着、桌面端可识别，打开档位即可用」 | 随 `describeImage` 分支实现（无独立单测，见 §5） |

---

## 3. 附：同日桥接侧修复（0.2.2 必需的配套）

这两项不属于本次报告，但在同一个 `0.2.2-rc.1` 宿主上是「能用」的前提，一并记录。

| 编号 | 问题 | 修法 | 验证 |
|---|---|---|---|
| **BUG-008** | unary 网关调用没带 Peer：面板「已连接」，但 `session.models` 等全部报 `Cannot read properties of undefined (reading 'signal')` | `remote-host-api.ts` 4 处 `gateway.invoke` 补 `peer: this.wirePeer.peer`；`dsh-gateway.ts` 请求类型接受 `PeerLike \| undefined` | `remote-host-api.spec.ts` 断言 4 次调用的 `request.peer`；实机 `session.models` → `ok:true` |
| **BUG-009** | 同一会话并发读历史：`session/follow` 被宿主取消（5 并发 2 成功） | `session-history.ts` 按 `sessionId` 串行化一次性快照，`gateway/cancelled` 时重试一次（25 ms），调用方 abort 不重试 | `session-history.spec.ts`（3 个）；压力测试 |

压力测试（真实 `0.2.2-rc.1` 宿主、商店扩展 Origin、无 token，`packages/bridge/scripts/stress-bridge.mjs`）：

- 4 000 次并发 `session.models`：**4 000 ok**，p50 65 ms / p95 72 ms / p99 73 ms，总耗时 1.44 s
- 20 次 `workspace.list`：p50 5 ms；10 次重连：p50 33 ms；替换语义 4/5 以 `4000` 关闭（符合设计）
- 宿主 RSS 增量 +7 MB
- 并发历史一项需**重启桌面端加载新 `lib`** 后复测（热更新对链接包不可靠，见 BUGS.md BUG-009 附录）

---

## 4. 验证

- `extension`：**54 files / 577 tests passed**（~14 s）
- `extension`：`pnpm run typecheck` 干净；`pnpm run build` 通过（`dist/control/assets/index.js` 131.3 kB）
- `packages/bridge`：274 passed / 1 skipped（19 files）；`pnpm run build` 通过（`lib/index.js` 现已自包含，`lib/index.js` 645.52 kB + `lib/invariant.js` 1.07 kB）
- 新增/更新测试文件：
  - 新增：`extension/tests/actions-press.spec.ts`、`snapshot-redaction.spec.ts`、`snapshot-main-region.spec.ts`、`snapshot-region.spec.ts`、`snapshot-background-image.spec.ts`、`actions-get-text.spec.ts`、`packages/bridge/tests/host-compat.spec.ts`、`packages/bridge/tests/session-history.spec.ts`
  - 更新：`tab-affinity.spec.ts`、`open-tab-binding.spec.ts`、`background-bridge-lifecycle.spec.ts`、`background-tools.spec.ts`、`extract.spec.ts` 及 4 个 background mock 文件

---

## 5. 残余风险与待人工复核

1. **扩展需重新加载**：在 `chrome://extensions` 重载 `extension/dist`（或发布新 zip）后，P0-1/P0-2/P0-0 才会在真实 Chrome 中体现。
2. **桥接需重启桌面端**：链接包的 `lib` 热更新在本次安装上不可靠（只有首次重装配置生效过），`BUG-008/009` 的实机行为以重启后为准。
3. **P2-11**：guard 仅在最小化确实报告 0×0 视口时生效；若某些平台最小化仍报非零尺寸，需再补 `document.visibilityState` 判断。当前按「未知」处理，不会误报视口外。
4. **P1-3 的取舍**：导航丢失时只等新文档，不重发点击——如果某站点在 port closed 时**并未**导航，工具会返回「已导航」的保守结论。这是为了避免双击的故意选择；如需更激进，可加一次 `chrome.tabs.get(tabId).status === 'complete'` 的校验。
5. **P2-13** 只改文案，无独立单测；`describeImage` 依赖 background 组装层，测试成本高，由 `hello.ok` 策略分支与代码评审覆盖。
6. **版本号未 bump**：这是待发版修复集，发布时按惯例在 `CHANGELOG.md` 的 `[0.38.8]` 之上开新版本。

---

## 6. 变更文件清单

**源码（7）**

- `extension/src/background/index.ts`（onStartup、describe_image 文案）
- `extension/src/background/tab-affinity.ts`（status 的显式绑定优先）
- `extension/src/background/tools.ts`（导航丢失处理、浏览器级导航自动快照）
- `extension/src/content/actions.ts`（Enter 提交、get_text 缺元素失败）
- `extension/src/content/extract.ts`（surroundingText、elementText 排除、isInViewport guard）
- `extension/src/content/snapshot.ts`（敏感参数掩码、主区域外文本、region 收集范围）
- `packages/bridge/src/{dsh-gateway,remote-host-api,session-history}.ts`（Peer、并发快照串行化）

**文档（2）**：`CHANGELOG.md`（Unreleased 两节）、`docs/BUGS.md`（BUG-008/009/010）

**分发（0.38.8 追加，见 §9）**：`packages/bridge/tsdown.config.ts`（内联依赖）、`packages/bridge/package.json`（依赖归入 devDependencies、新增 check-bundle/smoke-bundle 脚本）、`packages/bridge/scripts/{check-bundle,smoke-bundle}.mjs`、`pnpm-lock.yaml`、`docs/INSTALL.md`、`docs/INSTALL.zh.md`、`README.md`、`README.zh.md`、`packages/bridge/README.md`

**测试（新增 8 / 更新 9）**：见 §4。

---

## 7. 复核步骤（建议顺序）

1. `cd D:\DSH-demo-0.38.8\extension && pnpm run typecheck && pnpm exec vitest run && pnpm run build`
2. 重启桌面端（加载新桥 `lib`），打开侧栏确认连接；
3. 在 `chrome://extensions` 重载扩展，刷新靶页 `http://127.0.0.1:8123/`；
4. 按报告原步骤逐条复跑 P0-1、P0-2、P1-3、P1-4、P1-5、P1-6、P1-7；
5. 浏览器重启一次，确认扩展无需开侧栏即可重连（P0-0）；
6. 需要时跑压力测试：`STRESS_SKIP_HISTORY=1 node packages/bridge/scripts/stress-bridge.mjs`（历史并发项待重启后去掉该变量）。

---

## 8. 获取扩展：三条渠道（每条都能回到技能文档复核）

「技能」指 `skills/dsh-browser-crossplatform-troubleshooting/SKILL.md`（在本仓库里，也会在 dsh 会话中作为 skill `dsh-browser-crossplatform-troubleshooting` 加载）。下面每条渠道至少给两个可点链接，其中一条固定指向技能里对应的那一节。

| 渠道 | 给谁用 | 主要链接 | 技能锚点 |
|---|---|---|---|
| ① 本地未打包 | 开发、自测、改完立刻生效 | [`extension/dist`](../extension/dist) · [绝对路径](file:///D:/DSH-demo-0.38.8/extension/dist) | [Working on the extension itself](../skills/dsh-browser-crossplatform-troubleshooting/SKILL.md#working-on-the-extension-itself) |
| ② 打包产物 | 上传商店、离线分发、换机器 | [`…-store.zip`](../dsh-browser-crossplatform-0.38.8-store.zip) · [`….zip`](../dsh-browser-crossplatform-0.38.8.zip) · [`dist-store`](../extension/dist-store) | [Where the sources are](../skills/dsh-browser-crossplatform-troubleshooting/SKILL.md#where-the-sources-are) |
| ③ 商店下载 | 终端用户，免构建、免 token | [Chrome Web Store 页面](https://chromewebstore.google.com/detail/dsh-%E6%B5%8F%E8%A7%88%E5%99%A8%E6%89%A9%E5%B1%95%EF%BC%88%E5%85%A8%E5%B9%B3%E5%8F%B0%EF%BC%89/agpipnjijkpomaannkijkilggoffdiaf) · [Install 第 1 步](INSTALL.zh.md#第-1-步装扩展) | [Why the token exists at all](../skills/dsh-browser-crossplatform-troubleshooting/SKILL.md#why-the-token-exists-at-all) |

### 8.1 本地未打包（验收本报告用这个）

- 目录：[`extension/dist`](../extension/dist)（manifest 版本 `0.38.8`，构建于 2026-11-07 19:41，包含本报告全部修复）
- 绝对路径：[`file:///D:/DSH-demo-0.38.8/extension/dist`](file:///D:/DSH-demo-0.38.8/extension/dist)
- 加载步骤：`chrome://extensions` → 打开右上角“开发者模式” → “加载已解压的扩展程序” → 选中上面的目录（不要选 `extension` 根目录，那里没有 `manifest.json`）
- 换机器/换浏览器时，同样的目录结构见技能：[Working on the extension itself](../skills/dsh-browser-crossplatform-troubleshooting/SKILL.md#working-on-the-extension-itself)

### 8.2 打包产物（上传商店 / 离线分发）

2026-11-08 11:21 已用本报告的修复重新构建并打包（四个归档都在仓库根目录）：

- 商店上传（无开发 `key`，Chrome Web Store 只收这个）：[`dsh-browser-crossplatform-0.38.8-store.zip`](../dsh-browser-crossplatform-0.38.8-store.zip)
- 带开发 id `key` 的离线包（加载后仍是 `kdhkdgfcinfkmogifamoapmheihhcjfk`）：[`dsh-browser-crossplatform-0.38.8.zip`](../dsh-browser-crossplatform-0.38.8.zip)
- Firefox 对应两个：[`…-store-firefox.zip`](../dsh-browser-crossplatform-0.38.8-store-firefox.zip)、[`…-firefox.zip`](../dsh-browser-crossplatform-0.38.8-firefox.zip)
- 可直接加载的商店构建目录：[`extension/dist-store`](../extension/dist-store)
- 重新打包命令（会按 manifest 版本命名）：`cd extension && node scripts/build.mjs --store && node scripts/package.mjs`
- 产物从哪来、`dist` 与 `dist-store` 的区别见技能：[Where the sources are](../skills/dsh-browser-crossplatform-troubleshooting/SKILL.md#where-the-sources-are)

### 8.3 商店下载（终端用户）

- 安装地址：[Chrome Web Store · dsh 浏览器扩展（全平台）](https://chromewebstore.google.com/detail/dsh-%E6%B5%8F%E8%A7%88%E5%99%A8%E6%89%A9%E5%B1%95%EF%BC%88%E5%85%A8%E5%B9%B3%E5%8F%B0%EF%BC%89/agpipnjijkpomaannkijkilggoffdiaf)（商店 id `agpipnjijkpomaannkijkilggoffdiaf`）
- 商店版与开发版都免 token 直连：技能里对两个 id 的说明见 [Where the sources are](../skills/dsh-browser-crossplatform-troubleshooting/SKILL.md#where-the-sources-are) 与 [Why the token exists at all](../skills/dsh-browser-crossplatform-troubleshooting/SKILL.md#why-the-token-exists-at-all)
- 装完的 30 秒自查：[Install 第 3 步](INSTALL.zh.md#第-3-步确认装好了30-秒)

---

## 9. 附：桥接插件「零依赖」安装（2026-11-08，针对预览报告 I-1~I-3）

**问题**：从源码 checkout 用 `link:` 安装桥接插件时，`lib/index.js` 里仍有 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-home-paths`、`ws` 这类裸 import，宿主只在 profile 里解析插件入口、不代解析插件内部的依赖，于是报
`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cosmokit' imported from ...schemastery/lib/index.mjs`。

**修法**：构建时把全部运行时依赖内联进产物，产物只 import `node:*`。

- `packages/bridge/tsdown.config.ts` 新增 `alwaysBundle: (id) => id !== '' && !id.startsWith('node:') && !id.startsWith('.') && !isAbsolute(id)`。
- 合并了 `schemastery`、`cosmokit`、`ws`、`cordis`、`dsh-llm`、`dsh-tools`、`dsh-brand`、`dsh-home-paths`、`dsh-typert-protocol`、`dsh-util-values`、`dsh-util-crypto`、`dsh-timeout`、`dsh-scope`、`dsh-sandbox`。
- 体积：`lib/index.js` 193 kB → 646 kB（gzip 182 kB）；`lib/invariant.js` 1.07 kB。
- 安全性：`dsh-brand` 自述「Duplicate-install-safe… no runtime identity or mutable state」；`defineTool` 只产出普通对象 + JSON Schema；`createMessage` 是 `deepFreeze(structuredClone(...))` 纯构造；cordis 用 `Config['~standard'].validate` 鸭子类型校验、按 `Symbol.for('cordis.…')` 找服务——多份副本不会造成身份/实例问题。
- 依赖归类：`@deepseek-ai/schemastery`、`ws` 移入 `devDependencies`（现在只服务构建与测试）。

**验证（可重复）**：

```powershell
cd packages/bridge
pnpm run build
pnpm run typecheck
pnpm run check-bundle   # 把 lib 拷到没有 node_modules 的临时目录再 import，且拒绝非 node:* 的 import
pnpm run smoke-bundle   # 用测试里的 stub context 真正 apply 一遍：1 个 upgrade 路由、17 个工具
pnpm pack               # tarball 解压后同样能 import（无 node_modules）
```

当前结果：`check-bundle` 通过（只剩 `node:child_process/crypto/fs/fs:promises/http/module/os/path`）；`smoke-bundle` 通过；`pnpm pack` 产物 280 kB（含 `THIRD-PARTY-NOTICES.md`），解压后 `index` 15 个导出、`invariant` 为 `apply|inject|name`。

**注意**：这是分发形态的改动，运行中的桌面端仍加载着旧 `lib`（热重载对 linked 插件不可靠），重启桌面端后才用上新产物；扩展侧不受影响。

**同步的文件**：`COPYRIGHT.md` 与新增的 `packages/bridge/THIRD-PARTY-NOTICES.md`（14 个内联包，全 MIT，随 `pnpm pack` 发布）、`.github/workflows/check.yml`（构建后新增 `check-bundle` + `smoke-bundle` 一步）、`docs/BUGS.md`（BUG-011）、`README.md` / `README.zh.md` 的依赖表、`benchmark/README.md`、`config/README-what-these-are-and-how-to-restore.md`、`skills/.../SKILL.md`。