# 已知问题

按「先复现、再定位、再修」记录。每条都带**可核对的位置**（文件:行）和**原始错误字符串**，
因为报错文本本身就是查证入口 —— 它是代码里写死的，能直接定位到抛出它的那一行。

状态标记：`未修` / `调查中` / `已修（版本号）`

---

## BUG-001 — 导航打断派发时，`content-unavailable` 的自愈路径被跳过

**状态**：已修（0.38.6）
**首次发现**：0.38.5（扩展 `kdhkdgfcinfkmogifamoapmheihhcjfk`，未打包加载 `D:\DSH-demo-0.38.5\extension\dist`）
**影响**：连续 `browser_*` 调用在页面发生跳转时中断，模型收到一条不可操作的错误，必须靠人重试才能恢复

### 症状

页面主导航（尤其是 OAuth 跳转）发生在我派发一个内容脚本动作的**同一瞬间**时，工具调用失败并返回：

```
The content script stopped responding after the operation was dispatched. Call browser_snapshot before continuing.
```

连发第二次、第三次同样失败，间隔约 1–2 秒后自行恢复。三次实测原始报错：

| # | 报错 |
|---|---|
| 1 | `The content script stopped responding after the operation was dispatched. Call browser_snapshot before continuing.` |
| 2 | `The content script did not answer after it was loaded. Call browser_snapshot again before retrying.` |
| 3 | `The controlled tab was closed. Open the dsh browser control strip and bind the current page before retrying.` |

第 3 条发生在受控标签页真的被关闭时（我用 `active:false` 开后台标签页，受控目标漂移），
与第 1、2 条可能同源也可能不同源，**暂不合并**，等复现能区分再定。

### 复现

触发环境是可稳定重放的公开页面跳转：

1. 受控标签页停在 `support.broadcom.com/...`；
2. 派发一个会触发跳转的动作（当时是打开下载页，服务端 302 到登录页）；
3. 跳转目标是 `access.broadcom.com/default/ui/v1/signin/`（跨站、整文档导航）；
4. 在跳转的同一刻调用 `browser_snapshot` → 报第 1 条；
5. 紧接着再调 `browser_snapshot` → 报第 2 条；
6. 第三次调用恢复正常。

关键特征：**跳转是整文档导航**（`documentId` 改变），且该页在 iframe 里还有第三方
反机器人组件（`service2.mtcaptcha.com`，带了 `about:blank` 子帧）——`allFrames: true`
会把这些帧一并计入注入范围。

### 定位

抛出第 1 条的位置是

`extension/src/background/tools.ts:1008-1012`

```ts
} catch (error: unknown) {
  if (isCancelled(call, signal)) return cancelled()
  if (!contentScriptReceiverMissing(error)) {
    return unavailable('The content script stopped responding after the operation was dispatched. Call browser_snapshot before continuing.')
  }
  // …下面是注入自愈路径
  await injectContentScript(tab.id)
```

而 `contentScriptReceiverMissing` 只认一种形状

`extension/src/background/tools.ts:195-197`

```ts
function contentScriptReceiverMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist')
}
```

**由此可推断的事实链**（每一步都能核对）：

1. 能走到 1011 行，说明 `sendAction(tabId, …)` **确实 reject 了** —— 不是无限挂起；
2. 它的 rejection **不是** `'Receiving end does not exist'`，否则会走 1016 行的 `injectContentScript` 自愈；
3. 于是那些**本来能被自愈的**场景，被当成不可恢复错误回报给了模型；
4. `injectContentScript`（`tools.ts:162-177`）内部用 `pendingInjections` 做并发合并，且
   `chrome.scripting.executeScript` 本身的 rejection 也**没有**被转成友好错误 —— 它是
   `await` 在 try 里，失败就再抛。

`sendAction` 本身确实是裸的 `chrome.tabs.sendMessage`，**没有超时**

`extension/src/background/tools.ts:179-193`

```ts
return chrome.tabs.sendMessage(tabId, { … }, { frameId: frame.frameId })
```

全仓库唯一的导航等待超时在 `navigation.ts:60`（`waitForNextDocumentReady`，
`NAVIGATION_READY_TIMEOUT_MS`），**内容脚本动作这条路径没有等价保护**。
所以「挂起」和「reject」两种情况目前都没有统一出口。

### 疑似原因（待验证，不要当结论）

整文档导航销毁了内容脚本所在的 JS 上下文，`sendMessage` 因此以**另一种消息**被拒绝
（跨文档导航时 Chrome 常见的几种：帧已移除、端口关闭、上下文失效）。当前代码只识别了
`Receiving end does not exist` 一种。另外 `allFrames: true` 加上第三方 iframe，
会让「哪个帧先消失」变得不确定，可能放大这个窗口。

### 建议修法

1. **收窄判定条件**，把「接收端不存在」类错误统一成同一个谓词：匹配
   `Receiving end does not exist`、以及导航/帧失效类的消息；命中即走既有的
   `injectContentScript` 自愈路径，而不是回报不可恢复。
2. **给 `sendAction` 加一个有界超时**（与 `navigation.ts` 的思路一致），
   让「挂起」也有确定出口，超时后按第 1 条同样归入可自愈。
3. **让 `injectContentScript` 的失败也落到 `content-unavailable`**，
   别把 `chrome.scripting` 的原始 rejection 透出去。
4. **报错文案改成可操作的中文**，并把「已自动重试」与「需要人工重试」两种情况分开；
   现在这条英文长句对用户没有指引，模型也只能原样重来。

### 回归测试建议

在 `extension/tests/` 里加一个用例：模拟 `chrome.tabs.sendMessage` 以
「非 `Receiving end does not exist` 形状」的导航错误 reject，断言
(a) 不返回上面那条 `content-unavailable`，(b) 调用了 `injectContentScript`，
(c) 重试一次后返回成功。现有 `tests/background-tools.spec.ts` 顶部的 `mockChrome`
已经能做这件事。

### 实际修法（0.38.6）

`extension/src/background/tools.ts`。建议 1、3 照做，第 2 条**改了方向**，第 4 条只做了
「指向可操作」这一半 —— 理由写在下面，因为它和「看起来更省事」的做法相反。

**1）谓词扩容** —— `contentScriptReceiverMissing`（`:244`）从只认一句，扩到「接收端不存在」
这一族：`Receiving end does not exist`、`Could not establish connection`、`No frame with id`、
`was removed`、`Extension context invalidated`。

**它故意不收录「端口已关闭」**（`The message port closed …`）。
从发送端看，它和上面几种一模一样，但**不是同一个事件**：动作可能已经在页面上执行了，
只是回包丢了。据此重发 `browser_click` 就会点两次。所以这一种仍按不可恢复回报。
`background-tools.spec.ts` 里本来就有一条测试钉着这个取舍（原名
*"does not retry or roll back a dispatched action when its response port closes"*），
本次一个字没改，它继续通过 —— 这是「扩容没扩过头」的证据。

**2）超时：加了上限，但不自动重试** —— 新增
`CONTENT_ACTION_TIMEOUT_MS = 10_000`（`:188`），`sendAction` 用 `Promise.race` 包住
`sendMessage`，`finally` 里清定时器。

**这里与建议 2 的「超时后按第 1 条同样归入可自愈」不同**，是有意的：超时比端口关闭**更**
不可知 —— 端口关闭至少说明消息送到了，超时连「页面到底收没收到」都不知道。
若超时也去重发，`browser_press`/`browser_click` 就可能执行两次，而这是不可撤销的。
所以超时的出口是「确定地失败 + 告诉模型先 `browser_snapshot` 重读页面」，不是静默重试。
两处文案统一为 `DISPATCH_UNANSWERED`（`:199`），因为它们对调用方是同一件事。

**3）自愈失败不再透出原始 rejection** —— 主路径 `:1066-1069` 原本就已归入
`content-unavailable`；**漏的是图片路径** `requestImageTarget`（`:365-378`）：注入被拒或
第二次派发失败都会把 `chrome.scripting` 的原始 rejection 抛出去，而调用方
（`index.ts:2246`）把它报成 `internal` —— 一个不指向任何页面原因、也不给下一步的错误码，
同一个页面走 `browser_snapshot` 却是 `content-unavailable`。现已一并归入
`content-unavailable`。

**4）文案** —— 未改成中文：整条工具链的报错都是英文，单点中文化会让模型和用户看到两套
语言。只做了「可操作」这一半：超时与未分类两种都明确要求先 `browser_snapshot` 再重试。
「已自动重试 / 需人工重试」的区分本次未做，因为自动重试现在只发生在**确认接收端已消失**
时，这两种情况在文案上已经不混。

### 回归测试

`extension/tests/background-tools.spec.ts`，四条：

| 用例 | 钉住的行为 |
|---|---|
| `recovers in place when a navigation kills the frame the action was dispatched to` | 导航类错误 → 注入 + 重发 → 成功；且**不再**报「stopped responding」 |
| `still refuses a frame the page does not have, rather than injecting for it` | 扩容没扩过头：不存在的 frame 仍然直接拒绝，既不注入也不派发 |
| `bounds a dispatch that is never answered, so a hang has an exit` | 超时**有界**（假定时器）且**只派发一次**，不重试 |
| `answers content-unavailable when image recovery cannot load the content script` | 图片路径自愈失败 → `content-unavailable`，不再是 `internal` |

前三条在修之前都是红的（第 2 条一开始就绿，保留它是为了防扩容过头）。

### 复核

- `extension`：550 → 现 552 passed（含上述新增），`pnpm run typecheck` 通过；
- `packages/bridge` 全量通过，无回归。

---

## BUG-002 — 发送后输入框里的文字不消失，要手删；再按一次回车会重发同一句

**状态**：已修（0.38.6）
**首次发现**：0.38.5（本工作区源码；面板为侧边栏 `control/main.ts`）
**影响**：面板看起来像没发出去；同一句话会被重复发送，且每次都要人工清空输入框

### 症状

在侧边栏面板的输入框里写完指令、按回车发送后，输入框里的文字**仍然留在原地**，
必须自己全选删掉。面板其实已经收到了指令（对话里出现了这条消息、模型也回了），
所以这条"没发出去"的感觉是假的 —— 但字是真的没清。

### 定位

`extension/control/main.ts:853` 的 `submit()` 只清了状态字段，没清 DOM：

```ts
private submit(): void {
  const value = this.draft.trim()
  ...
  else void this.runPrompt(intent.text)
}
```

三条发送路径都在**各自的 promise 里**把 `this.draft` 清成 `''`
（`runPrompt` `:934`、`runCommand` `:906`、`runOpen` `:887`），
随后调 `refreshForTurn()`。而 `refreshForTurn()`
（`main.ts:1060`）只重建 header、transcript 和发送/停止按钮：

```ts
private refreshForTurn(): void {
  this.replaceHeader()
  this.renderTranscript()
  this.refreshComposerAction()   // ← 只换按钮，从来没有回写输入框的值
}
```

`<textarea>` 是**故意**保留不重建的节点（0.38.5 的改动就是为了不再丢焦点和打字），
于是 `input.value` 永远停在用户最后敲进去的那串字符上。
全仓库唯一那句 `input.value = this.draft` 在 `render()`（`main.ts:979`）和
`composerWrap()`（`main.ts:1759`）里 —— 而这两条路在一次成功的发送里都不会走：
发送走的是部分重绘。

**这是一次修复带出来的回归**：0.38.5（CHANGELOG "(Sending a prompt or stopping a run also
destroyed the composer)"）把这几条路径从完整 `render()` 改成部分重绘，解决了丢焦点，
但漏了"输入框的值也要跟着 `draft` 走"这一半 —— 改之前完整重绘会连值一起重建，
所以这个洞当时看不出来。

### 复现

1. 在面板输入框里输入 `总结这个页面`；
2. 按回车；
3. 消息已发出、模型开始回，**但输入框里仍是 `总结这个页面`**；
4. 再按一次回车 → 同一句话被发送第二遍。

### 修法

新增 `refreshComposerValue()`（`main.ts:1082`），在 `refreshForTurn()` 里调用，
并让 `render()` 复用同一个方法（原来那段逻辑内联在 `render()` 里）：

```ts
private refreshComposerValue(): void {
  const input = this.root.querySelector<HTMLTextAreaElement>('.composer__input')
  if (input === null) return
  if (input.value === this.draft) return
  input.value = this.draft
  this.autoGrow(input)
}
```

两个细节：**只有值真的不同才写**（无谓的重绘不该动光标，用户可能已经在输入下一条），
以及**顺带重算高度**，否则清空后输入框会保持上一次撑开的高度。

失败路径的行为**故意不变**：命令被拒时 `this.draft = echo` 会把原文放回输入框，
这是"被拒的命令可以改，不用重打"的设计（`control-page.spec.ts:896` 守着这条）。

### 回归测试

`extension/tests/control-page.spec.ts:875`（发给模型）与 `:896`（`@open`，不走模型）
各自断言发送后 `.composer__input` 的值为 `''`。

写测试时**先确认它能红**：在修之前这两条都以 `expected '总结这个页面' to be ''` 失败。
之所以 0.38.5 带着这个 bug 发布，正是因为整个测试套件里
**没有一条断言过发送后的输入框内容**
（`control-page.spec.ts:875` 原来的三个用例只断言"发出去了什么"，不问"框里还剩什么"；
`panel-simulation.spec.ts` 的两条专注焦点与"下一条还在不在"，也不看清空）。

### 复核

- `pnpm test`（extension）：551 passed（含新增 4 条）；`pnpm test`（packages/bridge）：253 passed, 1 skipped；
- `pnpm run typecheck`（extension）：通过；
- 同一份测试也把 0.38.5 原本就守住的"焦点不丢、下一条不被吞"跑了一遍
  （`panel-simulation.spec.ts` 100 轮无焦点丢失、无输入丢失），确认这次回写没有把它们弄坏。

---

## BUG-003 — 「扩展没装」的判定只认一个 id、只找四种 profile、还指向错的浏览器

**状态**：已修（0.38.6）
**首次发现**：0.38.5（报告人在 `agpipnjijkpomaannkijkilggoffdiaf` 上装的是商店版，默认浏览器 Chrome，同时开着 Edge）
**影响**：商店版用户会被告知「这台机器上没有任何浏览器配置装过这个扩展」，并被引向 `edge://extensions/` 的开发模式路线 —— 三句话里没有一句是对的

### 症状

报告人按官方 INSTALL 装好商店版扩展后，`browser_*` 调用全部失败并返回：

```
The extension is not installed in any browser profile on this machine, ...
It has to be installed once at edge://extensions/ (turn on developer mode, then "Load unpacked" ...)
```

而他装的**就是商店版**、就装在他**正在用的浏览器**里；桥接本身也一直在线。同一份报告里
另外两条根因（31 字符商店 id、版本不一致）已分别由 `9ba58ec` 与本轮修掉，这里是**第三条**。

### 三个独立缺陷，合起来生产了那句错话

**① 只认一个 id** —— `packages/bridge/src/browser-launch.ts:165`（0.38.5）

```ts
const EXTENSION_DIRECTORY_NAME = 'kdhkdgfcinfkmogifamoapmheihhcjfk'
```

`browsersWithExtensionInstalled()`（`:362-386`）拿它去查 `<profile>/Extensions/<id>`。
但一份构建**有两个可能的 id**：开发/未打包加载由 manifest 的 `key` 钉住第一个，而商店
**拒绝**带 `key` 的清单、自己分配第二个。商店版装在
`…\Extensions\agpipnjijkpomaannkijkilggoffdiaf\0.38.5_0`，于是永远查不到。

**② profile 只枚举到 `Profile 3`** —— `:381`

```ts
const profiles = ['Default', 'Profile 1', 'Profile 2', 'Profile 3']
```

自建 profile 目录名、`Profile 4` 及以上全部漏掉。

**③ 指向的浏览器是 `running[0]`** —— `:839`

```ts
const browserId = running[0]?.id ?? 'chrome'
```

`running[0]` 只是进程列表返回的先后。报告人默认浏览器是 Chrome、Chrome 也在运行，
但 `running[0]` 取到 Edge，于是报错把他导向 `edge://extensions/`。

**④ 文案超出了实际检查范围** —— `:847` 与 `:899` 断言
*"not installed in any browser profile on this machine"*，而实际只查了「一个 id × 四个目录名」。

**⑤（同一类，顺手查出）占位 id 被当成浏览器名用** —— 「默认浏览器」这个候选的 `id` 是字面量
`'default'`（因为操作系统给的是**路径**，不是名字）。而 `extensionsPageUrl()` 只认
`'edge'`、其余一律 `chrome://extensions/`，于是**默认浏览器是 Edge 的用户**会被导向
`chrome://extensions/` —— 和 ③ 是同一个「指错浏览器」的方向，只是发生在另一条分支。

### 实际修法（0.38.6）

`packages/bridge/src/browser-launch.ts`，三处缺陷各修一处，并让文案只声称查到的事：

- **`EXTENSION_DIRECTORY_NAMES`**（导出）取代单个常量，两个 id 都探测。仍是本地副本 ——
  该模块不能 import `../src/index.ts`（会成环），`extension-identity.spec.ts` 断言两份一致。
- **`chromiumProfileNames()`** 改为枚举真实的 user-data 根目录：只保留
  `Default` / `Profile <n>` 两种真实形状（所以 `Local State` 这个**文件**永远不会被当目录探测），
  序号按数值排序（`Profile 10` 不会排到 `Profile 2` 前面），`Default` 固定在前。
  **列不到目录时回退到原来那四个名字**，而不是返回空 —— 目录读不到**不能**变成「没装」。
  枚举能力通过 `LaunchDeps.listDirectory` 注入，便于测试。
- **扫描同时返回「查了什么」**：`scanExtensionInstalls()` 返回
  `{ installed, checked }`，`checked` 是 `<浏览器> (<profile 列表>)` 标签。
  `browsersWithExtensionInstalled()` 保留原签名与返回形状（只给 `installed`），
  在它之上实现，其它调用点不动。
- **`runningBrowserId()`**：默认浏览器优先（**但只在它确实在运行的那些里面选**，因为文案说的是
  "已在运行"）；匹配方式先按**规范化完整路径**，再按可执行文件**名**，且只有在恰好一个候选
  id 用这个文件名时才采信 —— `chrome.exe` 同时属于 Chrome 和 Chromium，有歧义就**不猜**
  （猜错正是本条 bug）。都没命中才退回 `DETECTION_ORDER`，最后才是原来的 `running[0]`。
- **文案**：两处都改为 `The extension was not found in the browser profiles this bridge read
  (…)`，逐条列出真正读过的浏览器与 profile；一个目录都没读到时说
  `the browser profile directories this bridge could locate`，不假装查过。安装方式**商店与
  开发者两条都给出**，不再只讲 "Load unpacked"。
- **⑤ 占位 id 先还原成真 id**：新增 `browserId = idOfDefaultExecutable(chosen.path, candidates)
  ?? chosen.id ?? 'chrome'`，四处 `extensionsPageUrl(chosen.id)` 全改成 `browserId`。
  `idOfDefaultExecutable` 对**无法识别**的路径返回 `undefined`（例如测试里那个不在候选表里的
  路径），此时才回落到占位 id —— 也就是说它**不会**猜。

### 回归测试

`packages/bridge/tests/browser-launch.spec.ts`（49 → 65 条）新增覆盖：商店 id 目录能被发现；
只装了商店版时文案说"已安装"；`Profile 4` 能被发现；`Local State` 永不被探测；目录列不到时
回退到已知名字；`checked` 标签稳定有序；默认浏览器优先于进程列表顺序；无法解析默认浏览器时
退回 `DETECTION_ORDER`；两处文案都只声称查过的东西；以及 **⑤**：默认浏览器是 Edge 且没连上时，
文案与 `installUrl` 都必须是 `edge://extensions/` 而不是 `chrome://extensions/`。
（写 ⑤ 这条测试时先用了 `/opt/edge/msedge`，它不在 Linux 候选表里、解析不出 id，于是照旧失败 ——
那是我测试写错了路径，不是修法没生效；换成真实的 `/usr/bin/microsoft-edge` 后才正确变绿。
顺带证明了这个实现**对认不出的路径不猜**。）
`extension-identity.spec.ts` 原先断言源码里 `const EXTENSION_DIRECTORY_NAME = '<id>'`，
重构后改为断言 `[...EXTENSION_DIRECTORY_NAMES]` 深等于 `[...DEFAULT_EXTENSION_IDS]` ——
比原来**更强**（原来只比第一个 id）。

### 复核

- `packages/bridge`：237 → 253 passed（+1 skipped），`pnpm run typecheck` 通过；
- 在报告人这台真机上跑 `scanExtensionInstalls('win32', process.env, …)` →
  `{ installed: ["chrome"], checked: ["chrome (Default)", "edge (Default)"] }`；
- 改动只落在 `packages/bridge/`，`git diff --numstat` 为 `+231/-37`（`browser-launch.ts`），
  不是整文件重写；四个改动文件的 CR 字节数均为 0（与仓库既有 LF 一致）。

---

---

## BUG-004 — 手动安装文档指向开发者路径，且没说明 `-store` 包缺 `key`

**状态**：已修（0.38.6）
**首次发现**：0.38.6（本轮对着 Release 产物核对安装文档时发现；不是用户上报）
**影响**：照文档手动加载扩展的人，会装成「永远连不上」的状态，而且没有任何线索指向"装错了包"

### 症状

文档第 1 步在讲"商店还没上架时怎么装"，原话是：

> 在 `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」→ 选构建好的
> `extension/dist` 目录。

这句话对**有源码 checkout 的开发者**成立，对**从 Release 下载的普通用户**不成立 ——
他们手上只有 zip，没有 `extension/dist`。于是有两种走法，而其中一种是坑：

1. 解压 `dsh-browser-crossplatform-0.38.6.zip` → 能连；
2. 解压 `dsh-browser-crossplatform-0.38.6-store.zip`（名字更"正式"，很容易被选中）→
   **侧边栏永远「未连接」**，而且看起来和"桌面端没开"一模一样。

### 定位

两个 zip 的 `manifest.json` 实测差异：

| 包 | 含 `key` | 手动加载后的扩展 id | 在桥接白名单里 |
|---|---|---|---|
| `…-0.38.6.zip` | **是** | `kdhkdgfcinfkmogifamoapmheihhcjfk`（由 `key` 推导，固定） | ✅ |
| `…-0.38.6-store.zip` | **否** | 由加载路径推导，每次装的位置不同就不同 | ❌ |

`-store` 不带 `key` 是**设计如此**：Chrome Web Store 拒绝带 `key` 的清单，id 由商店分配。
所以那个包只能上传，不能手动加载。

而桥接这一段是闭合的 —— `packages/bridge/src/server.ts:354-358`：

```ts
const loopbackNoToken = isLoopbackAddress(remoteAddress)
  && isTrustedExtensionOrigin(origin, this.deps.extensionId)
if (!loopbackNoToken && !verifyToken(this.deps.token, frame.token)) {
  ws.close(4002, 'bad token')
  return
}
```

不在白名单 + 空 token（扩展默认不带 token）⇒ 直接 `4002`。

### 实际修法（0.38.6）

改文档，改的是**可执行性**而不是措辞 —— `docs/INSTALL.md:37,40`、`docs/INSTALL.zh.md:36,39`：

- 选目录的标准从"`extension/dist`"改成**「含 `manifest.json` 的那个文件夹」**，并给出
  Release 场景的对应动作（先解压，再选解压出来的目录）；
- 新增一段明确写：**用不带 `-store` 的那个 zip**，并解释原因（`-store` 无 `key` → id 不在
  白名单 → 连接被拒），不再让用户靠文件名猜。

配套的另一半在 BUG-005：真装错了，面板要说得出原因。

### 复核

- 两个 zip 的 `manifest.json` 逐字段核对（`key` 的有无如上表）；
- 四个产物（chrome / chrome-store / firefox / firefox-store）的条目数、无反斜杠路径、
  manifest、图标 3/3、语言区域 3/3 均已校验；
- 文档改动不影响任何代码路径，全量仍为扩展 548 / 桥接 255(+1 skipped) / 协议 20。

---

## BUG-005 — 桥接以 `4002` 拒绝握手时，扩展只显示「未连接」

**状态**：已修（0.38.6）
**首次发现**：0.38.6（写 BUG-004 时顺着"用户装错之后会看到什么"查出来的）
**影响**：装错构建、扩展 id 不在白名单、或令牌不对的用户，看到的症状和"桌面端没启动"完全一样，无从判断，也没有下一步可做

### 症状

`ws://127.0.0.1:<port>/ext/bridge` 被以 `4002` 关闭后，侧边栏的状态点变红、文案是
「未连接」。而"dsh 没开"、"端口被占"、"网络问题"给出的也是同一个「未连接」。
四种原因、一个界面，**其中只有一种（4002）是用户自己能修的**。

这条不是本轮引入的 —— 仓库里原本就有一条测试的注释直接承认了它：

`packages/bridge/tests/extension-identity.spec.ts:12`

> ```
> * 以 close code 4002 拒绝，而面板只会说一句“未连接”。
> ```

### 定位

- 服务端**只**用 `4002` 表达"令牌或扩展 id 不匹配"：`packages/bridge/src/server.ts:357`；
- 扩展侧的关闭处理**只认 4000**（被另一个浏览器顶掉）：`extension/src/background/bridge.ts`
  的 `socket.addEventListener('close', …)`，其余关闭码一律落回通用的重连/停止路径；
- `BridgeState` 只有 `connecting | connected | reconnecting | stopped` 四个值，
  **没有"为什么"的通道** —— 所以面板即便想知道也拿不到。

### 实际修法（0.38.6）

给状态面加一条"最近一次被拒绝"的通道，只在面板上呈现，不改连接策略：

| 位置 | 改动 |
|---|---|
| `extension/src/background/bridge.ts:93` | 新增 `lastRejection: { code, reason } \| null`；`:211-212` 在 close 时记录 `4002`/`1008`；`:107`（`start()`）与 `:280`（连上）清空 |
| `extension/src/background/index.ts:361` | 把 `bridge.lastRejection` 放进 `ControlState.bridgeRejection` |
| `extension/src/settings.ts:261` | `ControlState.bridgeRejection?`（可选，避免既有测试夹具全量翻修） |
| `extension/control/main.ts:497` | 做形状校验后才采用（一次坏推送不该在面板上留一条假警告） |
| `extension/control/main.ts:954-956` | 渲染为 `alert` 级 notice，且**只在未连接时**显示 |
| `extension/control/strings.ts:149,256,362` | 中英文各一条可操作文案 |

文案给的是**下一步**，不是错误码：手动加载了带 `-store` 的包就换成不带 `-store` 的；
否则检查 token 设置。服务器原始字符串不摊给用户看。

两个刻意的取舍：

- **连上就清空**。否则一次历史拒绝会长期挂在面板上，反而误导 —— `:280`；
- **只记 4002 / 1008**。其它关闭码（含 1006 网络中断）不代表"你装错了"，
  记下来会制造假线索。

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `extension/tests/bridge.spec.ts:180` | 收到 `4002` 后 `lastRejection` 有值；重连并 `hello.ok` 后**清空** |
| `extension/tests/control-page.spec.ts:987` | `bridge: 'stopped'` + 拒绝记录 ⇒ 面板出现「桌面端拒绝了这次连接」 |
| `extension/tests/control-page.spec.ts:994` | `bridge: 'connected'` + 旧的拒绝记录 ⇒ **不**显示那条提示 |

### 复核

- `extension`：545 → **548 passed**（+3），`pnpm run typecheck` 通过；
- `packages/bridge`：255 passed（+1 skipped）、`packages/protocol`：20 passed，均无回归；
- 四个构建目标重建后，**真实浏览器 e2e**（握手 → 工具调用 → 图片中继 → 面板设置持久化）
  4 passed / 1 skipped，确认这条改动没有影响正常连接路径；
- 冷启动那条（`DSH_E2E_COLD_START=1`）在本机仍失败：81.8s 后 `connected === false`。
  原因是本机浏览器不加载 unpacked 扩展，与本次改动无关（未修改的 HEAD 上同样失败），
  **因此"自动拉起浏览器"这条路径在本机仍属未验证**。

---

## BUG-006 — 桥接只挂在宿主的随机端口上，扩展永远探不到

**状态**：已修（0.38.7）
**首次发现**：2026-10-17，宿主端口 50966
**影响**：扩展面板长期「未连接」；dsh 重启换了端口就复发

### 症状

- `http://127.0.0.1:50966/ext/bridge-config` 返回
  `200 {"wsUrl":"ws://127.0.0.1:50966/ext/bridge"}`；
- 扩展只探 `3080 / 3081 / 3090 / 14389 / 43189 / 19387`，六个端口全部 `ECONNREFUSED`；
- 扩展设置里 `bridgeUrl` 是空字符串（自动发现开着），不是配置错了。

### 根因

发现端点只注册在宿主 webServer 上，而宿主端口每次启动都变（实测见过 19387、57342、
60400、63571、50966）。扩展没有别的途径知道这次落在哪个端口上，只有撞上列表里的值才连得上。

### 修复

- `packages/bridge/src/index.ts`：按 `DISCOVERY_PORTS` 顺序绑第一个空闲端口，提供同一个
  `/ext/bridge-config`，并把 `/ext/bridge` 的升级交给同一个 `BridgeServer`（认证与 Origin
  白名单不复制一份）。全部端口被占时只记一条 warning，宿主端口那条路不受影响；
- 端口表从两份副本收成一份：`packages/protocol/src/index.ts` 导出 `DISCOVERY_PORTS`，
  bridge 与扩展都 import 它（测试仍然钉住具体数值，防的是有人无意改端口）；
- 新配置 `discoveryListener`（默认开）与 `discoveryPorts`（默认与扩展列表一致）；
- 「等服务就绪再挂载」的路径加了一次性守卫：依赖被替换时 inject 会重跑回调，不挡住就会把
  同一条路由注册两遍。

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `packages/bridge/tests/index.spec.ts` → `fixed-port discovery > serves the same discovery document…` | 固定端口返回同一份文档、WS 升级交给 BridgeServer、关闭后端口真的释放 |
| `… > skips a taken port and uses the next one` | 端口被占时换下一个 |
| `… > rejects a port list it cannot bind rather than crashing the host` | 全被占时只告警，不抛 |
| `… > keeps the extension probe list and the bridge default in step` | 桥接默认端口表与扩展探测表必须一致 |

### 复核

- `packages/bridge`：**263 passed**（+1 skipped），typecheck 通过；
- `packages/protocol` 20 passed、`extension` 548 passed，无回归；
- 构建后的 `lib/index.js` 在 3080 上起监听，实测 `/ext/bridge-config` 返回 200，关闭后释放端口；
- **未验证**：运行中的桌面端要重启才会加载新的 `lib`，重启后的真实连接待确认。

---

## BUG-007 — Host 的 Remote 流没带 Peer，连上就断：`hello.ok` → `stream-failed` → WS 1011

**状态**：已修（0.38.7）
**首次发现**：2026-10-17，桌面端 0.2.x，扩展已能发现 3080
**影响**：扩展反复重连、面板永远「未连接」；每次连接都在握手成功后立刻被关掉

### 症状

dsh 侧 `/ext/bridge-config` 已经在固定端口上返回 200，扩展也能连上，但连接一瞬间就断：

```
{"t":"hello.ok", ...}                                  ← 握手成功
{"t":"error","code":"stream-failed",
 "message":"TypeError: Cannot read properties of undefined (reading 'signal')"}
WebSocket closed 1011 (event stream failed)            ← 立刻关掉
```

`Get-NetTCPConnection -LocalPort 3080` 会看到成百上千条 `TimeWait`：扩展在无限重连。

### 根因

dsh 0.2.x 的 `TypertGatewayWireStream.open(endpoint, payload, uplink, peer, signal)`
在 `$events` 和 `session/follow` 里会读 `peer.signal` / `peer.principal` / `peer.interactions`。
桥接的 `openWireStream` 一直把第四位传成 `undefined`，于是 Host 在 `openRemoteEvents` 里第一行就抛：

```js
const lifetime = AbortSignal.any([signal, registration.lifetime.signal, peer.signal])
```

（`packages/bridge/src/dsh-gateway.ts` 的注释其实早就写了这个症状，但只处理了参数个数，没处理 Peer。）

### 修复

- `packages/bridge/src/dsh-gateway.ts`：新增 `PeerLike` / `createWirePeer`；优先
  `connection.createPeer({ principal: { kind: 'owner' } })`，旧宿主没有它时借用共享的
  `connection.browserPeer`（借用不释放）；`openWireStream` 的第四位改为这个 Peer。
- `packages/bridge/src/remote-host-api.ts`：适配器持有 Peer，`$events`、`session/follow`、
  `workspace/follow` 全部带上它；新增 `dispose()` 只释放自己造的 Peer。
- `packages/bridge/src/index.ts`：卸载时调用 `hostApi.dispose?.()`。
- 顺带修 e2e：真实桌面端占了 3080 之后，测试桥接会顺延到 3081 与页面 server 撞车；现在跳过
  `PAGE_PORT`，并把测试扩展的 `bridgeUrl` 钉到测试桥接，避免它去连真实的桌面端。

### 回归测试

| 用例 | 钉住的行为 |
|---|---|
| `packages/bridge/tests/remote-host-api.spec.ts` → `hands the Connection Peer to $events…` | 五参数 open 收到的第四位就是 Peer；`dispose()` 释放它一次 |
| `… > borrows the shared browser Peer when createPeer is absent…` | 回退到 `browserPeer`，且**不**释放借来的 Peer |
| `tests/e2e/extension.e2e.spec.ts` | 真实浏览器 + 固定 `bridgeUrl` 的握手与工具调用 |

### 复核

- `packages/bridge`：**263 passed**（+1 skipped），typecheck 通过；
- `packages/protocol` 20 passed、`extension` 548 passed，无回归；
- **未验证**：这次同样要重启桌面端才会加载新 `lib`；重启后应看到连接稳定、`TimeWait` 不再暴涨。

---

## 待补

- `The controlled tab was closed.` 与 BUG-001 是否同源 —— 需要能区分「标签页真关了」和
  「受控绑定漂移」的复现，再决定合并还是单列。
- ~~扩展 ID 的两套来源在**未打包加载**时的行为~~ —— **已结案（0.38.6）**。原先担心
  `.dsh\browser-extension` 那份 manifest 没有 `key`、只能由路径推导出
  `ccmhjdgbdgknaomhhddppfoadbifboom`、两个默认 ID 都对不上，现在确认**它不是问题**：
  那份是 0.3.1 旧副本，浏览器里真正加载的是 `D:\DSH-demo-0.38.5\extension\dist`
  （有 `key`，推出 `kdhkdg…hcjfk`，在默认列表里）。「未打包 + 无 key」确实会被桥接拒绝，
  但那是**设计如此**：路径推导出来的 id 每次都不同，无法进白名单；要么让构建保留 `key`，
  要么把该 id 写进 `extensionId` 配置。BUG-003 修的就是这类「查不到就下结论」的诊断。
