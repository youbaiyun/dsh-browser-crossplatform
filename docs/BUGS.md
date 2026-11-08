# 已知问题

按「先复现、再定位、再修」记录。每条都带**可核对的位置**（文件:行）和**原始错误字符串**，
因为报错文本本身就是查证入口 —— 它是代码里写死的，能直接定位到抛出它的那一行。

状态标记：`未修` / `调查中` / `已修（版本号）`

本文件从 `0.38.8` 起只保留当前两版（商店 `0.38.7` / 未打包 `0.38.8`）相关的问题记录，
更早版本的条目已随旧版本移除；编号仍沿用原序号。

---

## BUG-008 — unary 网关调用没带 Peer：面板「已连接」，但对话全废

**状态**：已修（待发版）
**首次发现**：2026-11-07，桌面端 0.2.2-rc.1 + 扩展 0.38.7
**影响**：面板显示「已连接」，`workspace.list` 也正常，但任何走 unary 网关调用的操作都失败——
`session.models` 直接回错，模型选择器拿不到目录，发消息也走不下去

### 症状

同一条连接里两种结果，非常好认：

```
{"t":"rpc","id":"q1","method":"session.models","payload":{}}    → {"ok":false,
  "error":{"code":"gateway/internal","message":"Cannot read properties of undefined (reading 'signal')"}}
{"t":"rpc","id":"q2","method":"workspace.list","payload":{}}    → {"ok":true, ...}
```

`session.create` / `session.history` 反而回 `ok:true`：那是 session-deferral 层给的临时 id
和备份空事件，不代表模型链路是通的，很容易被误判成「模型报错」。

### 根因

dsh 0.2.2-rc.1 的 `TypertGatewayService.prepareInvocation()` 第一行就是
`assertPeerLive(request.peer, endpoint)`，而它读的是 `peer.signal`：

```js
function assertPeerLive(peer, endpoint) {
  if (peer.signal.aborted) throw new TypertGatewayError('gateway/peer-disposed', ...)
}
```

0.38.7 给 Remote 流（`$events`、`session/follow`、`workspace/follow`）补了 Peer，
但 `RemoteHostApi` 里 4 处 `gateway.invoke({...})` 仍然只传 `signal`。0.2.2 没有兜底；
同一仓库 devDependency 的 0.2.0-rc.2 有 `request.peer ?? this.operatorPeer()`，所以
**测试全绿也发现不了这个问题**——除非断言的是 Peer 本身。

### 复现

不需要浏览器扩展，直接拿 `ws` 连桥：

1. 连 `ws://127.0.0.1:3080/ext/bridge`，`Origin: chrome-extension://<扩展 id>`；
2. 首帧 `{"t":"hello","token":"<~/.dsh/ext-bridge-token>","caps":{"textOnly":true,"snapshotMaxChars":32000,"maxInteractiveItems":60}}`；
3. 发 `{"t":"rpc","id":"q1","method":"session.models","payload":{}}` → `ok:false`（上面那条错）；
4. 同连接发 `workspace.list` → `ok:true`，正好把「Peer 导出」这一层隔离出来。

### 修法

- `packages/bridge/src/remote-host-api.ts`：4 处 `gateway.invoke` 全部补
  `peer: this.wirePeer.peer`（`call()` 通用分发、`session.history` 的 `page`、
  `session.models` 的 `modelCatalog` 与 `projections`）。
- `packages/bridge/src/dsh-gateway.ts`：`TypertGatewayLike.invoke` 的请求类型加
  `peer?: PeerLike | undefined`（借来的 `browserPeer` 场景下 `wirePeer.peer` 可能为空）。

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `packages/bridge/tests/remote-host-api.spec.ts` → `hands the Connection Peer to every unary invoke…` | 4 次 unary invoke 的 `request.peer` 都是同一个 Peer；只断言 `ok:true` 不够，rc.2 会兜底放行 |

### 复核

- `packages/bridge`：**264 passed**（+1 skipped），`pnpm run build`（`tsc -b` + `tsdown`）通过；
- 实机（宿主 0.2.2-rc.1）WS 复现：`session.models` → `ok:true`，
  `groups = deepseek-official:2, deepseek-account:2`，`workspace.list` 仍 `ok:true`；
- 链接插件的热重载**不可靠**：后续实测里 Plugin Manager 的 `set_plugin`/`set_bundle` 都报 applied，
  运行中的宿主却仍在跑启动时加载的那份模块（机制见 BUG-009 附）。所以让新 `lib` 生效**以重启桌面端为准**；
  本次实机验证发生在宿主已经重新装配过一次之后。

---

## BUG-009 — 同一会话并发读历史互相顶掉：`session/follow` 被 Host 取消

**状态**：已修（待发版）
**首次发现**：2026-11-07，桌面端 0.2.2-rc.1 + 桥 0.38.8（压力测试发现）
**影响**：扩展对同一个 `sessionId` 同时发两条以上 `session.history`（不带 `beforeSeq`）时，
只有一两个成功，其余报 `gateway/cancelled`

### 症状

```
session.history ×5 并发 → ok: 2
  ×3 {"code":"gateway/cancelled","message":"Remote invocation \"session/follow\" was aborted"}
```

串行 5 次全成功（每次 11–14 ms，344–360 条事件，`hasMore: true`）；并发时首个和最后一个成功、
中间失败，所以很容易被当成「偶发抖动」。

### 根因

`oneShotSessionSnapshot()` 为了取一页历史会自己开一条 `session/follow`。Host 对每个 Session
只保留一条活跃 follow，新流一开旧流就被 abort（网关里 `remoteCancelled(endpoint)` →
`RemoteError('gateway/cancelled', …)`）。桥这边从不串行化，扩展的并发读就必然互踩。
扩展订阅事件之后走的 `EventGeneration` 路径不受影响，最容易踩中的是「还没订阅事件就读历史」
的时序和纯 WS 客户端。

### 修法

- `packages/bridge/src/session-history.ts`：新增 `SNAPSHOT_QUEUE: Map<sessionId, Promise>`
  把同一会话的一次性快照串起来；`openSnapshot()` 在 `gateway/cancelled` 或 message 含
  `aborted` 时重试一次（间隔 25 ms），调用方自己 abort 的不重试。
- 不改协议、不改 Host 调用形状，只是把桥内部的并发收敛掉。

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `tests/session-history.spec.ts`（3 个） | 并发 3 次全部成功；第一次被 Host 取消后重试一次；调用方 abort 不重试 |

### 复核

- `packages/bridge`：**274 passed**（+1 skipped），`pnpm run build` 通过；
- 实机：当前宿主里加载的仍是 17:51 那一版 `lib`（原因见下），所以并发历史实测仍是 2/5；
  重启桌面端后该阶段应全绿，重启前可用 `STRESS_SKIP_HISTORY=1 node scripts/stress-bridge.mjs`
  先跑其余阶段。

### 附：链接插件的热更新不总生效

这次依次试过 `set_plugin include:bridge-browser`、`set_bundle` 关→开、甚至把 `main` 指到新文件名，
宿主仍在跑启动时加载的那份模块（临时塞进 `openSnapshotOnce` 的 300 ms 延迟一次都没出现）。
`@deepseek-ai/dsh-hmr` 的 `reconcileProfile()` 会把「模块在宿主自己的静态依赖链里」
（`host-module`）或「entries 与 running 数量对不上」（`unmanaged-plugin`）的模块登记为 pending，
登记过的 URL 之后再变也不识别。**结论：改 `packages/bridge` 的源码后以重启桌面端为准，
别指望 Plugin Manager 一定能把链接包的新 `lib` 顶进去。**

---

## BUG-010 — 实机测试报告（2026-11-07，桌面端 0.2.2-rc.1 + 扩展 0.38.7）13 项

**状态**：已修（待发版；P2-9 复核为「本来就对，补测试」）
**首次发现**：2026-11-07，Chrome 155，商店扩展 id `agpipnjijkpomaannkijkilggoffdiaf`，
靶页 `http://127.0.0.1:8123/`
**影响**：其中 P0-1/P0-2 会让「跟到后台标签页」和「后台开标签页」在默认
`tabSwitch: 'follow'` 下全部失效；P0-0 让浏览器重启后扩展不再自动连回来；其余是
自动快照/文本/报错语义上的不一致

### 根因与修法

| 编号 | 现象 | 根因 | 修法 |
|---|---|---|---|
| P0-1 | `follow_tab` 成功，但快照读的是另一个标签页 | `TabAffinity.status()` 在 `follow` 模式下把显式绑定当成 `following`，`resolveTarget()` 于是返回可见标签页 | `status()` 先看 `keptActiveTabId`，显式跟随/后台绑定优先于 `follow` 偏好 |
| P0-2 | `open_tab{active:false}` 建好了标签页却报 `controlled tab changed` | 同上：`allowsTarget(newTab)` 为 false → `targetChanged()` | 同上；`bindOpenedTabAffinity` 的 `rebindControlled` 生效 |
| P0-0 | DSH/浏览器重启后扩展不重连，直到手动开侧栏 | 没有 `chrome.runtime.onStartup` 监听；`alarms` 跨重启不保证 | 新增 `onStartup` → 重新 `armBridgeKeepalive()` + `startBridge()` |
| P1-3 | 点击触发导航，却报「content script stopped responding」 | 文档卸载让 `sendMessage` 以 port closed 失败 | catch 里识别 `dispatchLostToNavigation`，等新文档就绪后拍快照；**绝不重发点击** |
| P1-4 | `press Enter` 不提交表单 | 只发合成 `submit` 事件，不触发提交流程 | `form.requestSubmit()` / 点 submit 按钮；`preventDefault()` 时不动 |
| P1-5 | 快照 URL 里出现 `pwd=s3cret` | URL 原样渲染 | `redactSensitiveUrl()` 掩码 `pwd/token/sig/api_key/otp/…`，保留 `user=alice` 这类普通参数 |
| P1-6 | `<main>` 外的标题/导语消失；delta 说「没有可见变化」 | readability 只渲染主区域 | `surroundingText()` 按文本节点补齐主区域外的内容，跳过 nav/aside/footer/script/style |
| P1-7 | `navigate`/`back`/`forward`/`reload` 有时不自动快照 | `dispatchTabNativeTool` 直接返回 `navigationPending` | 导航类工具也 `waitForNextDocumentReady` + `snapshotAfterNavigation`；目标不可注入时不干等 |
| P2-8 | `region` 只裁正文，清单还是整页 | 交互清单/图片按整页收集 | 用 `regionEl ?? document` 作为收集范围 |
| P2-9 | CSS 背景图不进 Images | ——（复核：本来就支持） | 补回归测试 `snapshot-background-image.spec.ts` |
| P2-10 | `<style>` 文本混进正文 | 非 `HTMLElement`（内联 SVG）退回裸 `textContent` | 逐文本节点读并跳过 `SCRIPT/STYLE/NOSCRIPT/TEMPLATE`（SVG 的 `tagName` 是小写，统一 `toUpperCase()`） |
| P2-11 | 最小化窗口把所有元素标成 `[outside viewport]` | 0×0 视口让公式全判 false | 视口宽/高 ≤ 0 时视为「未知」，不标注 |
| P2-12 | `click` 缺元素报错，`get_text` 缺选择器却成功 | `get_text` 把「没命中」写进成功文本 | 缺元素时抛 `ActionError('action-failed', …)`，与 `click` 一致 |
| P2-13 | `describe_image` 说识别关闭，`hello.ok` 却报 `imageRecognition: true` | 两个开关说混了：桌面端「愿意识别」vs 扩展「看图档位关」 | 错误文案区分两者，并说明打开档位即可用桌面端 |

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `extension/tests/tab-affinity.spec.ts` → `keeps tools on an explicitly followed background tab in follow mode` | follow 模式显式绑定后台标签页后，工具目标仍是它；用户真切走才回到 `following` |
| `extension/tests/open-tab-binding.spec.ts` → `targets a background open even when the switch mode is follow` | `active:false` 的后台打开成为目标 |
| `extension/tests/background-bridge-lifecycle.spec.ts` → `reconnects on browser startup without waiting for the panel to be opened` | `onStartup` 触发新 socket + keepalive alarm |
| `extension/tests/background-tools.spec.ts` → `reports a click that navigated away as navigation…` | 只发一次 `browser_click`，答案带新页面快照 |
| `… > attaches the new page snapshot after a browser-level navigation` | 浏览器级 `navigate` 也等新文档并拍快照 |
| `extension/tests/actions-press.spec.ts`（5 个） | Enter 提交流程、textarea 不提交、`preventDefault` 生效 |
| `extension/tests/snapshot-redaction.spec.ts`（6 个） | URL/delta/链接/src 的敏感参数掩码，百分号编码也认 |
| `extension/tests/snapshot-main-region.spec.ts`（3 个） | 主区域外文本进入快照，delta 能看见变化 |
| `extension/tests/snapshot-region.spec.ts`（2 个） | `region` 同时裁交互清单 |
| `extension/tests/snapshot-background-image.spec.ts`（2 个） | CSS 背景图进 Images，渐变不进 |
| `extension/tests/actions-get-text.spec.ts`（2 个） | 选择器没命中时报错；0×0 视口不误判 |
| `extension/tests/extract.spec.ts` → `never leaks style or script source into page text` | 内联 SVG 的 `<style>` 不进正文 |

### 复核

- `extension`：**54 files, 577 passed**（~14 s）；`pnpm run typecheck` 干净；`pnpm run build` 通过。
- 仍需人工复核的一项：Chrome 真·最小化时 `window.innerWidth/height` 的实际取值（P2-11 的
  guard 在 0 时生效；若某些平台最小化仍报非零尺寸，需要再看 `document.visibilityState`）。

---

## BUG-011 — 从源码 `link:` 安装桥接还要「补依赖」：产物把运行时依赖留在外面

**状态**：已修（待发版；分发形态改动）
**首次发现**：2026-11-07，预览报告 I-1（桌面端 0.2.2-rc.1，扩展 0.38.8 预览版）
**影响**：换机器、干净 checkout 或用 `file:` tgz 安装插件时，加载直接失败；`pnpm`
的 `auto-install-peers` 还会把整套 `@deepseek-ai/dsh-*` 装进包内，其中
`dsh-llm` 又缺自己的依赖，越补越坏

### 现象

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cosmokit'
  imported from ...\node_modules\@deepseek-ai\schemastery\lib\index.mjs
```

同一 checkout 里 `packages/bridge/node_modules` 在，宿主就能加载；换个目录/换台机器就报错。

### 根因

`tsdown` 默认把 `dependencies` 与 `peerDependencies` 都外置，`lib/index.js` 里仍
保留 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、
`@deepseek-ai/dsh-home-paths`、`ws` 这些裸 import。宿主的
`cordis-plugin-loader` 只把「插件入口」按 profile 作用域解析（它写
`.cordis/resolve.mjs`，内容是 profile 的 `import.meta.resolve`），插件文件内部的
import 按插件自身的 realpath 解析——也就是 checkout 的 `node_modules`。所以
`link:` 装的是「目录」，不是「补齐过的包」。

### 修法

| 改动 | 内容 |
|---|---|
| `packages/bridge/tsdown.config.ts` | `alwaysBundle`：除 `node:*`、相对路径、绝对路径外全部内联 |
| `packages/bridge/package.json` | `@deepseek-ai/schemastery`、`ws` 移入 `devDependencies`；新增 `check-bundle` / `smoke-bundle` 脚本；`files` 增加 `THIRD-PARTY-NOTICES.md` |
| 产物 | `lib/index.js` 193 kB → 646 kB（gzip 182 kB），只剩 `node:*` import |
| `packages/bridge/scripts/check-bundle.mjs` | 把 `lib/` 拷到没有 `node_modules` 的临时目录再 import，非 `node:*` 的 import 直接失败 |
| `packages/bridge/scripts/smoke-bundle.mjs` | 用测试里的 stub context 真正 `apply`：1 个 upgrade 路由、17 个工具 |
| `packages/bridge/THIRD-PARTY-NOTICES.md` | 14 个内联包（全 MIT）的清单与 MIT 文本，随 `pnpm pack` 发布 |
| CI `.github/workflows/check.yml` | 构建后新增一步跑上面两个脚本，推广告物回归为红灯 |

安全性依据：`dsh-brand` 自述 duplicate-install-safe、无运行时身份与可变状态；
`defineTool` 只产出普通对象 + JSON Schema；`createMessage` 是
`deepFreeze(structuredClone(...))` 纯构造；cordis 用
`Config['~standard'].validate` 鸭子类型校验、按 `Symbol.for('cordis.…')`
找服务——多份副本不会造成身份或实例问题。

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `pnpm --dir packages/bridge run check-bundle` | 空目录可 import，且只剩 `node:*` |
| `pnpm --dir packages/bridge run smoke-bundle` | 内联后的插件仍能 apply：1 路由 / 17 工具 |
| `pnpm pack` 后解压 import | 发布物（`lib` + `src` + 声明 + notices，无 `node_modules`）自包含 |
| `packages/bridge` 全量测试 | 19 files，274 passed / 1 skipped |

### 复核

- 旧 checkout 报 cosmokit 错，只说明 `lib/` 是内联前的产物：重建即可，不要补依赖。
- 运行中的桌面端仍加载旧模块（linked 插件热重载不可靠），需要重启桌面端才算真正加载新产物；
  扩展侧不受影响。

---

## BUG-012 — 解压加载的扩展被判定为「未安装」

**状态**：已修（待发版）
**首次发现**：2026-11-08，用户实测（Windows 10、Edge 157、扩展以「加载已解压」安装，Edge Secure Preferences 里 `location: 4`）
**影响**：扩展明明在跑、面板也开着，任一 `browser_*` 工具却回答「扩展没装」并劝用户再装一遍；用户白忙，且这句错误建议会掩盖真正的原因

### 现象

桥接已监听、扩展尚未连上时触发工具，返回：

```
The extension was not found in chrome (Default)…, which is why nothing connects.
It has to be installed once at chrome://extensions/ …
```

而用户刚用「加载已解压的扩展程序」把 `extension/dist` 装进了 Edge，并能打开面板。

### 根因

`packages/bridge/src/browser-launch.ts` 的 `scanExtensionInstalls` 只探测
`<profile>\Extensions\<id>\` 目录。商店安装会在那里留副本，**未打包加载不会**——它只在
`<profile>\Secure Preferences`（旧浏览器在 `Preferences`）的 `extensions.settings` 里记
一条 `location: 4` 的条目，`path` 指向加载目录。于是「装了」被读成「没装」。

同一处还有一句错误假设：「未打包加载只撑一个会话，下次启动就没了」——只对命令行
`--load-extension` 成立；在 `chrome://extensions` 里点的「加载已解压」会一直保留。

### 修法

| 改动 | 内容 |
|---|---|
| `scanExtensionInstalls` | 除目录外，还读该 profile 的 `Secure Preferences` / `Preferences`，把 `extensions.settings` 的键当作已记录的扩展 id；两条证据任一成立即算安装 |
| 读取注入 | 新增可注入的 `readFile`（默认 `readFileSync`），坏文件/读不到按「没有记录」处理，不抛错 |
| 文案（两处） | 不再断言「没装、必须装一次」；改为「没找到安装记录」并给出两条路：已加载就确认 `chrome://extensions` 里启用，否则商店或「加载已解压」装一次（两种安装都会跨重启保留；只有命令行加载不保留） |

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `tests/browser-launch.spec.ts` → `finds an unpacked extension that only left a record in the profile preferences` | 只有 `Secure Preferences` 记录（`location: 4`）也算安装 |
| `tests/browser-launch.spec.ts` → `treats an unreadable or corrupt preferences file as no record` | 坏偏好文件不会崩，也不会误报安装 |
| 既有 `probes every id…` / `finds a store install…` | 商店安装（`Extensions\<id>`）路径不回归 |

### 复核

- 在装有商店版 Chrome 与未打包 Edge 的机器上，`scanExtensionInstalls` 能同时读到两种证据；
  台架实测 `chrome`（商店 `agpip…`）与仅偏好文件记录的未打包安装都能命中。
- 若解压加载的构建没有 `key`，浏览器推导出的 id 每次不同、不在白名单，即使检测到也连不上：
  这种情况下要加载带 `key` 的 `extension/dist`，而不是换 id。

---

## BUG-013 — 面板报错指向已不存在的设置项

**状态**：已修（待发版）
**首次发现**：2026-11-08，用户实测（扩展 0.38.8、桌面端 0.2.2-rc.1）
**影响**：用户在设置表里找一个并不存在的地址/token 输入框；这句话还和排障手册「面板已无连接设置」相矛盾

### 现象

面板未连接时发送任一 RPC，底部提示：

```
未连接 dsh（请检查设置中的地址与 token）
```

而设置表里只有「dsh 连接状态」、共享/对话/标签页/视觉、开关与宽度——没有地址和 token。

### 根因

`extension/src/background/index.ts` 的 `gatewayRpc` 拒绝分支沿用了旧文案。地址与 token 早已
改为由桌面端自动发现（`bridgeUrl`/`token` 只是存储里的逃生口，面板没有输入框），文案没跟上。
`extension/control/strings.ts` 的 `bridgeRejected` 也还写着「检查扩展的 token 设置」。

### 修法

| 改动 | 内容 |
|---|---|
| `gatewayRpc`（中/英） | 改为「桌面端可能没在运行，或连接还没建立；先启动桌面端再重开面板。地址与 token 由桌面端自动发现，面板里没有这两项设置」 |
| `strings.ts` `bridgeRejected`（中/英） | 去掉「检查 token 设置」，改为按排障手册检查桌面端桥接配置，并明说面板没有 token 输入框 |
| `control/main.ts` 注释 | 注明地址/token 不在设置表里，文案不要再指向它们 |

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `tests/background-session.spec.ts` → `rejects a prompt with a clear message while the bridge is not connected` | 错误以 "not connected" 开头讲清原因，提 desktop app，且不再出现 `Settings` |
| `tests/control-page.spec.ts` → `names a rejected connection…` | 拒绝连接的提示仍然出现，且不再出现「token 设置」 |

### 复核

- 面板设置的唯一入口是右上角齿轮；连接地址与 token 不在其中，自动发现失败时按排障手册处理。
- 旧扩展（0.38.7 商店版）仍是旧文案：重载 `extension/dist` 后才会变。

---

## 待补

- `The controlled tab was closed.` 是否与「受控绑定漂移」同源——需要能区分「标签页真关了」
  与「绑定漂移」的复现，再决定合并还是单列。
- ~~扩展 ID 的两套来源在**未打包加载**时的行为~~——**已结案**：没有 `key` 的构建只能由路径推导 id，
  每次不同、进不了白名单；要么构建保留 `key`，要么把该 id 写进 `extensionId`。
  当前两个构建（商店 0.38.7 带 `key`、未打包 0.38.8 用开发 `key`）都在默认白名单内。
