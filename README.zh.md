> English: [README.md](README.md)

# dsh-browser-crossplatform

让 dsh 桌面端读取并操作一个浏览器标签页的 MV3 扩展 + 桥接插件：页面以**文本**交给模型  
（带编号的可操作控件），需要看图时另有一条**可选**通道，默认关闭。这是 [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) 的衍生重写版，按「**兼容性高、去臃肿化优先**」重构，兼顾稳定性与高效。

在插件市场里可按 **`dsh-plugin`** 找到本插件（市场约定的话题词 ✓）。

与其他同类项目的区别：**跨平台**（Windows / macOS / Linux，平台相关代码集中在一个模块里）· 根包**零 dsh 依赖**  
（桥接把 dsh 全声明为 peerDependencies）· **看图可选且默认关闭** · 全仓**统一版本号** ·  
附带**与本机 Playwright 基线成对比较**的基准测试与 CI。

## 安装

三条路，任选一条：

| 要什么                      | 从哪拿                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **浏览器里的扩展**（侧边栏面板）       | 浏览器扩展商店（[Chrome]（待上架）/ [Firefox]（待上架））                                                                                  |
| **桌面端那一半**（让 dsh 与扩展说上话） | 本仓库 —— [github.com/youbaiyun/dsh-browser-crossplatform](https://github.com/youbaiyun/dsh-browser-crossplatform)，一条命令，见下 |
| **离线包**（自己加载 / 商店上传用）    | [Releases](https://github.com/youbaiyun/dsh-browser-crossplatform/releases) 里的两个 zip                                    |

```sh
# 从 npm 装（已发布：dsh-browser-crossplatform@0.38.6）：
dsh plugin --profile desktop add dsh-browser-crossplatform   # 命令行版 dsh web 用 --profile web

# 或者直接从这个仓库装，不经过 npm：
git clone https://github.com/youbaiyun/dsh-browser-crossplatform
dsh plugin --profile desktop add link:<clone>/packages/bridge
```

**一步步的傻瓜式步骤（含"怎么确认装好了"）见 [docs/INSTALL.md](docs/INSTALL.md)。**

扩展本体从浏览器商店安装（或按下面的构建一节自行加载未打包版本）；上面的包是桌面端那一半，  
插件设置页就在 dsh 里，标题是「dsh 浏览器扩展（全平台）的桌面端一半」。

## 结构（五个包同一个版本号 `0.38.6`）

```
packages/protocol   零依赖的线上协议（帧校验、能力/授权分离）
packages/bridge     dsh 桥接插件（WebSocket 服务端 + browser_* 工具，跑在 dsh 内）
extension           Chrome/Firefox MV3 扩展本体
skills/             排障 skill：侧边栏出问题时由你的 AI agent 读，一种症状对一节，
                    照着就能修好，不需要用户自己去开 devtools
```

## 适配范围（所有端与最低版本）

| 端                               | 最低版本                                                 | 这个数字出自哪里                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **操作系统**                        | Windows ✓ / macOS ✓ / **Linux ✓（CI 就是 Linux，验得最扎实）** | 平台相关代码只集中在一处：`packages/bridge/src/browser-launch.ts`（它必须知道每个平台把浏览器和配置放在哪）；构建/基准脚本另加 Windows 的 `.cmd` 指名。其余都是平台无关的。CI 的 `ubuntu-latest` **就是 Linux**，每次提交都在上面跑完整链 |
| **dsh 桌面端**                     | **任意 `0.2.x`** —— 声明为 `>=0.2.0-rc.2 <0.3.0` 且 **optional**，已在 `0.2.1-rc.2` 上验证 | dsh 是宿主、在运行时提供这些包，所以桥接把它们声明为**可选 peer**（带范围，绝不精确锁定）。范围只用来标注支持的产品线；真正让预发布版宿主编译得过的是 `optional`——因为 semver 的预发布规则会把 `0.2.1-rc.2`（当前桌面版）排除在所有 `0.2.x` 范围之外，连 `*` 和 `0.2.x` 也排除。运行时真正的闸门是能力检查（`gateway.wireStream`）：缺必需服务会带名字报错，缺 agent registry 则降级成空操作 |
| **Node**                          | **≥ 20**                                             | 根包、桥接、扩展的 `engines.node`（协议包不声明——它是私有工作区包，没有要跑的脚本）                                                                                         |
| **桌面 Chrome / Chromium / Edge** | **116**                                              | `extension/manifest.json` 的 `minimum_chrome_version`                                                                                                             |
| **桌面 Firefox**                  | **140.0**                                            | `extension/manifest.firefox.json` 的 `gecko.strict_min_version`                                                                                                   |
| **面板界面**                        | Chrome 用 `side_panel`、Firefox 用 `sidebar_action`     | 两者都指向同一个 `control/index.html`                                                                                                                                    |
| **构建/测试（开发）**                   | Node **22** + pnpm **11**                            | `.github/workflows/check.yml`                                                                                                                                    |
| **手机 / 平板**                     | ❌ 不支持                                                | 见下                                                                                                                                                               |

桥接的运行时依赖只有 `ws` 与 `@deepseek-ai/schemastery`，两者都与平台无关；扩展把两个面板依赖（`marked`、`dompurify`）打进构建产物。  
CI 会构建两个浏览器目标并跑完全部测试（含真启动 Chromium 的端到端用例）；  
Windows 在本机验过；macOS 未被 CI 覆盖，但它与 Linux 同为 POSIX，且平台相关面就是那一个模块。

**回环免令牌只绑定具名的扩展 id。** 桥接正常用 bearer 令牌认证，但来自扩展自身的回环升级会跳过它，以保持零配置发现。这条豁免不是"任何 `chrome-extension://` 来源"——机器上每个其他扩展都有这样一个来源——而是与 `extensionId` 精确相等；该配置项是逗号分隔的列表，默认列出两个 id：本仓 manifest `key` 推出的 `kdhkdgfcinfkmogifamoapmheihhcjfk`，以及 Chrome 应用商店分配的 `agpipnjijkpomaannkijkilggoffdiaf`。两个都要列，是因为商店拒收带 `key` 的清单，于是开发加载与商店安装呈现的是不同来源。你自己的构建请把 id 加进这个列表；把插件配置里的 `extensionId` 设为 `''`，则包括回环在内所有连接都必须出示令牌。

**手机与平板为什么不支持**：Chrome / Edge for Android 不支持第三方扩展；  
Firefox for Android 没有侧边栏这种界面；而且桥接**在关键处只回环**——免令牌通道与特权网关方法  
（`host.openPath`、`settings.*`、`credentials.*`）都要求回环来源（`packages/bridge/src/server.ts`），  
手机连到的是另一台机器上的 `127.0.0.1`。持有有效令牌的非回环来源仍可用普通会话方法（`dsh web --host`  
存在的意义），但拿不到特权方法。

## 与原版的关键差异

| 维度         | 原版                                                                        | 本版                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本         | 根 0.2.1 / 扩展 0.3.1 / 桥 0.0.7 各自漂移                                         | 统一 `0.38.6` —— 根包、协议、桥接、扩展与两个 manifest 全一致                                                                                                                                                         |
| Node       | `^22.19 \|\| >=24`                                                        | `>=20`                                                                                                                                                                                             |
| TypeScript | 扩展 5.6 与桥 6.0 分裂                                                          | 单一工具链：扩展声明 `^5.6`、桥与协议声明 `^5.7`，lockfile 只解析出一个已安装版本                                                                                                                                               |
| 依赖         | 根包 35 个 `@deepseek-ai/*`（RC）、node_modules 600MB                           | 根包 **0 个** dsh 依赖（它的 typecheck/测试是纯 Node + 自带 tsc）；桥只有 `ws` 与 `@deepseek-ai/schemastery` 两个运行时依赖，dsh 全声明为 `peerDependencies`（运行时 `ctx.get()` 探测宿主，不内嵌）；扩展只有 `marked` + `dompurify` 两个面板依赖，且都打进面板产物 |
| 桥接死依赖      | React peer + 3 个 web 端 `dsh-client-ui-*`/`locale` peer + `dsh.client` 注入块 | **全部移除**（扩展面板自带，不往 dsh 的 web 客户端注入 UI）                                                                                                                                                             |
| 桥接协议       | 自带 `protocol.ts`（12.7 KB）与扩展各存一份                                          | 共享 `@dsh-browser/protocol`，由打包器内联进两份产物                                                                                                                                                             |
| 桥接冗余       | 另有 web 端 `client.js`（7.2 KB）                                              | 删除                                                                                                                                                                                                 |
| 注入         | manifest 全局 `content_scripts` 注入每个站点的每个 iframe                            | 同样保留全局 `content_scripts` 声明（扩展无法预知你会指向哪个标签页），但**在另一端收窄**：只有你绑定的那个标签页会被读取或操作，`chrome.scripting` 则用于给「安装前就已打开」的标签页补注入。见 `docs/TRUST-MODEL.md`（广注入、窄授权）                                               |
| 浏览器下限      | Chrome 116 / Firefox 140                                                  | 同上游要求，未放宽（Chrome 116 / Firefox 140）                                                                                                                                                                |
| 构建         | 3 个 vite 配置 + shared + build.mjs（5 文件）                                    | 同样的形状，这是有意的：一个 `build.mjs` 顺序跑三个目标，`vite.shared.ts` 放它们共用的部分。变化在于配置清单集中在一个脚本里，而不是分散在三处文档里                                                                                                          |
| 测试运行器      | vitest + jsdom                                                            | vitest（jsdom 环境跑扩展面板，node 环境跑桥接）                                                                                                                                                                   |

## 核心机制

- **文本快照 + 动作执行**：不截图、不做图像识别（协议层 `textOnly: true`）。页面渲染成结构化文本：标题/URL/正文（readability-lite）+ 编号交互清单（含 ARIA role 控件）+ 表单字段（含 `masked`/`checked`/`required`），支持 `delta` 差分与 `region` 局部快照。
- **安全不变量**：敏感字段（`type=password`、`autocomplete=credit-card|cc-*`、id/name/aria-label 命中 `password|passwd|credit|card|cvv|cvc|secret|pwd`）的值一律掩码成 `••••`；**可访问名永不使用输入框的当前值**（仅 submit/button/reset 类的 value 作名），并有单测钉死。
- **工具面（17）**：`browser_snapshot` / `click` / `type` / `press` / `scroll` / `navigate` / `open_tab` / `list_tabs` / `follow_tab` / `close_tab` / `back` / `forward` / `reload` / `get_text` / `wait` / `launch` / `describe_image`。完整参数面：`delta`/`region`/`replace`/`amount`/`selector`/`ms`/`active`/`tabId`/`index`/`text`/`key`/`direction`/`url`，以及 7 个帧局部工具上的 `frame`。`browser_describe_image` 只在识别开启时才有答案；`browser_launch` 是唯一在桌面端执行的工具——因为只有它能在"没有浏览器"的情况下做事。
- **浏览器没开时把它拉起来（`browser_launch`，以及每个工具调用前的预检）**：工具执行都在扩展里，所以浏览器关着就没有可派发的对象——以前直接抛一个干巴巴的 `bridge-closed`。现在无连接时会先尝试启动浏览器，再报告实际结果。它启动的是**你本来就在用的浏览器**：可执行文件从系统"默认浏览器"记录里读取（Windows/macOS），并且**不加任何额外参数**——不加 `--user-data-dir`（那会变成另一个浏览器，没有你的标签页和登录态），也不加 `--load-extension`。如果该浏览器**已经在运行且开着窗口，则什么都不启动**（再启动一次只会把请求交给已有进程并丢弃参数，相当于白开一个窗口），回答里直接说明该去哪个浏览器里启用扩展。`browserUserDataDir` + `extensionPath` 是为开发场景准备的：在指定配置目录里真正加载未打包构建。
- **它做不到的事**：替你安装扩展。命令行加载只活一个会话、什么都不安装——关掉浏览器就没了——而且从 Chrome 137 起，带品牌的 Chrome/Edge 已完全不认 `--load-extension`（Chromium 与 Chrome for Testing 仍认）。所以扩展必须在那个配置里装一次（商店，或在扩展页"加载已解压的扩展程序"），之后正常启动就会自己连回来。桥接会检查 Chrome/Edge/Brave/Chromium 配置里有没有 `<profile>/Extensions/<id>`，然后如实说明你处在哪种情况，而不是给一个帮不上的建议。
- **帧路由**：快照组合主帧与所有可访问 iframe，子帧标注为 `[frame N] <origin>`；后台记住 `N → frameId`，后续带 `frame` 的工具路由到同一帧；各帧在同一份协商预算内渲染，正文先被截断（`mainBudget = maxChars × 0.5`），长页面吞不掉交互清单。
- **超出上游的能力**（在上游实现之上补的能力，不是删减）：`browser_type` 能填 `<select>`（按 option value → 可见标签 → 1-based 序号依次匹配，失败时列出可用选项）并用 true/false 设置 checkbox/radio；`browser_wait` 支持等待条件（`selector` / `text`，未出现则以 `timeout` 错误码失败），不再只是固定延时。
- **导航后自动快照**：content 脚本在新文档就绪时宣告（等价原版 `DSH_CONTENT_READY`），后台在导航类动作（navigate/back/forward/reload）后握手等待新文档并自动快照，推送到面板——不必再要求模型多跑一轮。
- **图片清单（不接视觉也有用）**：移植的管线原本**完全丢掉裸 `<img>`**——图片不在交互选择器里，`innerText` 也不带 `alt`。现在快照末尾新增 `Images:` 节：按文档顺序、按最近标题分段，每行渲染为 `[N] kind WxH "label" near="…" text-described [unavailable] → src ⟦iN img:state⟧`（`content/snapshot.ts` 的 `renderImage`）。`N` 与交互清单用的是同一套编号，所以节里的号就是 `browser_click` 要的号（对可点击的图而言）；`text-described` 标记作者本身已给文本的图片，行尾标记携带识别状态，因此分节与正文内标记永远一致。定位由 DOM 给出，模型不需要坐标。标记经过 nonce 转义，页面无法伪造分节或其中的状态。  
  **覆盖的图片表面**：`<img>`（含 `currentSrc`，因此报的是 `srcset` 实际选中的候选，而不是回退项）、`<video poster>`（封面是普通图片 URL，走同一条取图路径）、内联 `<svg>`（无字节可取，以 `kind=svg` 报出，绝不会交给取图路径）、以及 CSS 背景图——内联 `background-image` 精确采集，类声明的走**有界 computed-style 扫描**：逐一访问区域内的元素，直到 `BACKGROUND_SCAN_LIMIT`（1500）个元素或 `MAX_BACKGROUND_IMAGES`（20）张背景图（先到者为准），已作为 img/svg/video 收集过的元素与 `script`/`style` 标签会被跳过。**不采集 `<canvas>`**：画布没有可取的地址，读回来等于读页面内存，因此干脆不列它，而不是列成"读不到"。  
  **渲染对着后台的答案进行**：内容脚本采集图片并带外返回 `ImageView[]`，`Images:` 一节就由这些视图渲染；后台才是持有识别结果与缓存的一侧——因为识别是异步的，后台在拿到答案后才把每个标记的状态填进去。每个 iframe 渲染自己那一节，所以编号是帧局部的。**预算用的是交互项预算本身，不是第二份预算**：图片上限是 `maxItems` 的三分之一（下限 4），与交互清单共用编号与上限，因此六十张缩略图的页面挤不掉控件（`content/snapshot.ts` 的 `imageCap`）。
- **取图与识别缓存（后台）**：`background/image-fetch.ts` 在 **service worker 里**取图——扩展上下文持有 host permissions，能直接读内容脚本永远读不到的跨域图片字节（内容脚本画布会被污染）；带 `credentials:'include'` 以覆盖登录后的媒体。它**不解码、不缩放、不转码**：拿到多少字节就返回多少，取不到就说明原因；超过 `MAX_IMAGE_BYTES`（4 MB，因为 base64 会膨胀三分之一、且整个负载要过 WebSocket）的响应不带在帧里，改由调用方把 URL 交给桌面端去取。失败**被分类而不是抛出**（`too-large` / `unsupported-url` / `fetch-failed` / `empty`，并对"本次会话内不可能再成功"的失败带 `permanent` 标记），因为模型必须被告知"这里有图但读不到"，而不是看不到任何东西。`background/image-cache.ts` 按**图片身份（URL）**&#x7F13;存结果与失败，落到 `chrome.storage.local`、有效期 24 小时、最多保留最近 200 条描述、瞬时失败最多重试两次——缓存首先是为了**一致**（同一个 logo 出现在三十行里，不能给出三十句互相矛盾的描述），其次才是省成本；不放在内存里是因为 MV3 worker 会被随时停止再启动。`background/vision.ts` 是**识别器的接缝**：直连云端与经桌面桥接只差那一个被注入的函数，取图/缓存/渲染完全相同。
- **两条识别通道，桌面中转优先**：协议新增 `image.call` / `image.result` 一对帧，`hello.ok` 的 policy 增加 `imageRecognition`。扩展先自己取图（只有它带登录态），拿到字节就随帧发下去；取不到才把 URL 交给桌面，由桌面用不受 CSP／host permission／企业策略约束的网络栈去取——这是桌面中转真正的价值，也是为什么帧里带的是 `source` 而不是固定的那一种。桌面侧 `vision.ts` 调配置好的 chat-completions 模型（默认 `deepseek-flash`，图片走 data URL，`thinking` 关闭，`usage` 回读以便确认开关真的生效），`image-relay.ts` 负责取字节或按 URL 兜底并分类失败。凭据留在桌面：当既没有配置 `visionApiKey`、也无法从桌面凭据库解析出 `DEEPSEEK_API_KEY` 时，`hello.ok` 报 `imageRecognition: false`。`background/vision.ts` 每次请求挑通道：**桌面只要声明了中转就用中转**，否则才走扩展自己的直连。
- **外接 API 直连（识别这一步在界面上不可见）**：`background/vision.ts`（`DirectRecognizer`）让扩展自己调外接 API，配置从 `chrome.storage.local` 读（`visionEndpoint` / `visionApiKey` / `visionModel`；超时与 `thinking` 开关只存在于桌面端插件配置），**不新增任何界面**——面板只显示「看图」档位，不暴露任何识别相关输入。真实失败（429 等）当场结算，不会为同一张图付两次钱。看图相关设置与其他设置同在 `src/settings.ts`，面板从不暴露它们。关键保证：**识别这一步不建会话、不写文件、不产生对话条目**——它只是后台里一次普通外发调用；描述备忘落在 `chrome.storage.local`（24 小时过期）。两条路径共用 `protocol/src/vision-contract.ts` 的提示词与解析器，所以「谁调模型」不改变问了什么、也不改变什么算合格回答。
- **面板 markdown**：模型回复用 `marked` 渲染、`DOMPurify` 净化；流式期间保持纯文本（避免逐帧重解析），定稿后渲染；回复中的链接在新标签打开，不跳出面板。
- **审批确认**：状态变更动作可改为先问用户（`unrestrictedBrowserAccess` 开关、受信源、单次允许）。该开关**出厂即开**，所以新装不会被询问；关掉它即恢复审批。它开着时还会覆盖「让 AI 读取网页」的选择，因此选了"先问我"也不生效。
- **按需注入**：受控标签页不依赖 manifest 的 `content_scripts`——脚本经 `chrome.scripting` 注入受控标签页，导航后重新注入；manifest 里那条声明的意义是让「扩展安装/重载之前就已打开」的标签页也已被覆盖。
- **标签页亲和**：工具绑定单一受控标签页。手动切换标签页的行为由「跟随标签页」设置决定：`follow`（**出厂默认**）把绑定移到你切过去的新页面，`ask` 阻塞并询问留在原页面还是跟过去，`keep` 留在原页面。
- **会话桥接**：面板提示词经 `rpc` 帧发往桌面 dsh，assistant 文本流式回传。
- **桥接插件**：`/ext/bridge` 上的 token 认证 WebSocket，`hello` 握手协商 caps/policy，`browser_*` 工具以 `tool.call` 帧下发给扩展，特权网关方法对非回环远端一律拒绝。

## 看图（图像识别）

界面里只有一个开关：面板 → 设置 → **看图**（关 / 低 / 标准 / 增强）。默认**关**；打开之后你问的那张图会离开本机，交给配置的模型（见下）。

**调用去哪**是部署配置，不是设置项 —— 面板只显示"看图"档位，不暴露任何识别相关的输入框，端点/模型/key 由部署方设定（桌面端插件配置，或扩展存储）。面板测试守住这条线：`extension/tests/control-page.spec.ts` 断言它不提供浏览器无法兑现的控件，而档位下拉是它渲染的唯一识别相关字段。


**桌面中转（推荐）**：在桌面端 profile 的 `cordis.patch.yml` 里给桥接加一个 key，地址与模型已有默认值（`https://api.deepseek.com/v1` / `deepseek-flash`），思考默认为关：

```yaml
- id: bridge-browser
  disabled: false
  config:
    visionApiKey: <key>
    # 可选；id 必须是接口 id，不是显示名 ——
    # 填 deepseek-flash，不要填 DeepSeek-V4.1-Flash（接口会 400）。
    visionModel: deepseek-flash
```

**浏览器直连**：没有界面入口，按部署写入扩展存储即可（manifest 的 `connect-src` 本来就允许任意 `https:`/`http:` 主机，不需要改 manifest）：

```js
chrome.storage.local.set({ dshSettings: { visionEndpoint: 'https://…/v1', visionModel: '…', visionApiKey: '…' } })
```

`tools/vision-stub.mjs` 与 `tools/vision-proxy.mjs` 是开发工具：前者量本地开销，后者让扩展在不改 manifest 的前提下走云端。日常用法不需要它们。

## 命令

```sh
pnpm install
pnpm -r run typecheck   # 全仓类型检查（协议 + 桥接 + 扩展）
pnpm -r run test        # 全部单测（桥接的 e2e 需要一个 Chromium，见下）
pnpm --filter dsh-browser-extension run build           # Chrome → extension/dist
pnpm --filter dsh-browser-extension run build:firefox   # Firefox → extension/dist-firefox
pnpm --filter dsh-browser-extension run build:store     # Chrome，不含 manifest 的 key → extension/dist-store
pnpm --filter dsh-browser-extension run package         # 全部归档 → 仓库根目录
pnpm --filter dsh-browser-crossplatform run build  # 桥接插件 → packages/bridge/lib
```

`package` 写出 `dsh-browser-crossplatform-<version>.zip` 与 `…-<version>-firefox.zip`：文件名取自包内 manifest 的版本，并拒绝 `\` 作为条目分隔符（商店会拒收这种包）。**要上传商店的是 `-store` 那一个，不是普通的那个**：普通构建带着 manifest 的 `key`（用于开发时固定扩展 ID），而 Chrome 应用商店明确拒收含该字段的包。完整提交流程（含"商店分配的 ID 对桥接意味着什么"）见 [docs/STORE.md](docs/STORE.md)。要在本机跑桥接的 e2e，先给它一个仍遵守 `--load-extension` 的浏览器：`node benchmark/lib/browser-install.mjs chromium`，再把 `PLAYWRIGHT_CHROMIUM_PATH` 设为 `node benchmark/lib/chromium-path.mjs` 打印的路径。

## 端到端评测（benchmark/）

把"高效"从形容词变成数字的仪器：同一个模型、同一份 profile、同一组任务、同一台机器，**对比两种浏览器执行后端**——`playwright`（runner 内置的基线插件）与 `extension`（本仓库真实的桥接 + 已构建的扩展）。基线只暴露这六个任务真正需要的 8 个工具（`snapshot`/`click`/`type`/`press`/`scroll`/`navigate`/`get_text`/`wait`），而产品有 17 个——所以对比的是同样的任务，而不是完全相同的工具面。

六个任务覆盖浏览器 agent 的基本形态（读 / 单步 / 表单 / 搜索 / 多步 / 动态加载），按 **seed** 变化以防过拟合，跑在 `benchmark/site/` 的夹具站点上。每个任务记四个数：**成功率**（120 秒超时算失败）、**完成耗时** p50/p90/mean（从模型收到任务到 DSH turn 结束）、**平均工具调用次数**、**平均 prompt token**。

必须成对跑的理由：绝对耗时被模型支配（生成约占一半），只有对照才能把后端自己的贡献分离出来。

```sh
pnpm --dir benchmark install-browser          # 下载与 lockfile 中 playwright-core 匹配的 Chrome for Testing
node benchmark/run.mjs --dry-run --smoke      # 不调用模型的基础设施检查
node benchmark/run.mjs --smoke                # 调一次真实模型（消耗额度）
node benchmark/run.mjs                        # 正式：6 任务 × 5 seed × 2 后端 = 60 次
node benchmark/run.mjs --tasks order_lookup,contact_form --seeds 1-5 --trials 2
```

三个前置条件，缺一个它就跑不起来：

1. **一个能接受 `--profile web --patch … -- --no-open --port N` 的 dsh 命令行** ✗ —— 上游仓库把 `@deepseek-ai/dsh` 当依赖，那里 `pnpm exec dsh` 直接可用；**这份重写是独立工作区，没有这个依赖**（桥接是装进桌面端 profile 的），所以要自己指：`BENCHMARK_DSH_COMMAND="node D:/path/to/dsh.mjs"`。
2. **Windows 上用 `pnpm.cmd`** —— 全局安装同时提供 `pnpm` / `pnpm.cmd` / `pnpm.ps1`，而 `child_process.spawn` 只能执行前两者，且 Node 18+ 还要求 `.cmd` 必须经由 shell。脚本已处理这两点，并把实际使用的命令写进失败信息里。
3. **Chrome for Testing 或 Chromium** —— 新版 Google Chrome Stable 会忽略 `--load-extension`，不能作为扩展后端的自动评测浏览器。

`benchmark/tests/` 是评测工具自身的单测（`node --test tests/*.test.mjs`，不需要模型与浏览器）。

## 状态

四项能力已全部补齐，另加图片清单节、后台取图/缓存、外接 API 直连与桌面中转识别。下表列出各套测试，**具体条数以 `pnpm -r run test` 的输出为准**（此前这里写死的数字已经漂移过两次，所以不再写死）。

| 能力               | 实现                                                                                                                                                                               | 验证                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 内容管线（与原版等价 + 扩展） | `extract` / `privacy` / `ids` / `snapshot` / `actions` 全量移植：可访问名优先级、敏感字段掩码、forms 数组、ARIA role、稳定 id、delta、region；另外补了 `<select>`/checkbox 填写、`browser_wait` 等待条件、`Images:` 图片清单节 | jsdom 测试（含安全不变量断言）                                                                                        |
| 帧路由              | `[frame N]` 编号 + `N → frameId` 路由表，各帧在同一份协商预算内渲染                                                                                                                                 | 5 项单测（`frames.spec.ts`）                                                                                   |
| 导航后自动快照          | content 就绪宣告（`DSH_CONTENT_READY` 等价）+ 后台握手 + 导航后自动快照推面板                                                                                                                          | 随 e2e 与双构建通过                                                                                              |
| 面板 markdown      | `marked` + `DOMPurify`，流式纯文本 / 定稿渲染，链接拦截                                                                                                                                         | 双构建通过                                                                                                     |
| 桥接插件测试套件         | 原版 spec 全量迁移（vitest）                                                                                                                                                             | 17 个 spec 文件，其中一个就是 e2e                                                                                   |
| 端到端              | Playwright 加载已构建扩展 + 真实 BridgeServer：零配置发现 → caps 协商 → `session.create`/`prompt`                                                                                                 | 在 CI 中真跑（Playwright 自带 Chromium 仍遵守 `--load-extension`）；没有这种浏览器时它会自跳过，所以要看日志而不是只看退出码                      |
| 浏览器启动路径          | 第二个 BridgeServer + 经 `browser-launch` 启动的真实浏览器，让"浏览器本来是关着的"有被测试过的答案                                                                                                              | `packages/bridge/tests/browser-launch.spec.ts`（单测，注入副作用）与一个需显式开启的 e2e（`DSH_E2E_COLD_START=1`，因为它会真的启动浏览器） |

测试运行器：**协议用 Node 内置 `node --test`**；**扩展与桥接用 `vitest`**（桥接套件自原版原样迁移，不重写断言）。  
`locales.spec.ts` 里「与商店上架文案一致」的检查，在 `store-assets/store-listing.md` 存在时就会跑——本仓库里它存在，所以这项断言是生效的（它同时管着三语描述 132 字符的上限）。  
e2e 需要一个仍遵守 `--load-extension` 的浏览器——Playwright 自带 Chromium 可以，而带品牌的 Chrome/Edge 137+ 已移除该开关；缺浏览器或 `extension/dist` 时自动跳过。可用 `PLAYWRIGHT_CHROMIUM_PATH` 指定。

### 分层原则（为什么这些代码在它现在的位置）

- **纯逻辑与接线分开**：校验进来方向的数据、生成给用户看的审批文案、编码字节、解析帧号与组合跨帧快照——这些是纯的，因此放在可单测的模块里（`background/tools.ts` 负责派发与帧路由、`background/authorization.ts`、`background/frames.ts`、`background/image-fetch.ts`）。接线留在 `background/index.ts`。
- **组合根也可测**：每个加载 `background/index.ts` 的 spec 都用 `vi.stubGlobal` 装一份够用的 `chrome` 桩（见 `tests/background-tools.spec.ts` 顶部的 `mockChrome`），于是"每个事件都有监听器""content-ready 会被答复""非面板的 port 被忽略"这些**接线本身**有了断言。
- **类型与守卫同源**：`tabSwitch` 由 `background/tab-affinity.ts` 里紧挨 `TabSwitchMode` 联合类型导出的 `isTabSwitchMode` 解析，所有落盘设置都经 `settings.ts` 的同一个 `normalizeSettings` 对照 `SETTINGS_DEFAULTS` 归一——给面板加控件却忘了教后台接受它，会由解析器暴露出来，而不是变成"点了没反应"。
- **成本保证可验证**：`visionThinking: off` 无法从请求体证明生效（服务商可以静默忽略），所以启动时发一次 1×1 图的自检并**回读 `usage`**；只有真的看到 reasoning token 才告警，看不到就保持安静（不误报）。
- **未使用的导入/参数是错误**：`tsconfig.base.json` 开了 `noUnusedLocals` + `noUnusedParameters`，这类腐化不能再静默堆积。
- **跨包不共享小工具**：`isRecord` 这类三行类型守卫在协议包与桥接包各自保留一份，因为把线协议包变成通用工具包不值得。

`extension/src/content/images.ts` 是 `Images:` 节的采集半边（参与每次构建），格式（包括"页面无法伪造分节行"）由 `extension/tests/images.spec.ts` 钉住，因此不接模型也能审阅格式。

待办（目标外）：`background/index.ts` 可继续拆分；桥接的 `composition.spec.ts`（4 用例，真实 Loader）与 `session-purge.spec.ts`（12 用例）未迁移，需要再补约 15 个 dsh 包作为 devDependency。

**提示注入不变量，现在有断言了**：组装给模型的提示必须保持纯 ASCII，这样网页没有同形字可以冒充浏览器面板发言。两半都是导出的具名常量（`packages/bridge/src/index.ts` 的 `BROWSER_PROMPT_PREAMBLE` / `BROWSER_PROMPT_MARKER_RULE`），`packages/bridge/tests/index.spec.ts` 会在任一半出现非 ASCII 字符、或开始把标记本身抄进提示时失败。

**身份不变量同样有断言**：桥接的免令牌通道只绑定具名的扩展 id，测试从两个方向守住这条绑定——`packages/bridge/tests/extension-identity.spec.ts` 从 `extension/manifest.json` 的 `key` 重算 id 并与 `DEFAULT_EXTENSION_IDS` 的第一项比对（扩展不在同级目录时——例如从 npm 单独安装插件——自动跳过），同时断言本项目两个 id 都在默认列表里，并断言未列出的 id、已列出 id 的前缀、其它 scheme、以及空配置**都仍被拒**；`packages/bridge/tests/origin-gate.spec.ts` 钉死"只有列表中精确的 Origin 可免令牌"的判据。`extension/tests/versions.spec.ts` 保持五个包版本一致（根包、协议、桥接、扩展与基准测试，再加两个 manifest）；`node extension/scripts/extension-id.mjs` 可以打印某个构建的 key 实际推出的 id，便于人工核对。

## 许可

MIT。本工程是 [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser) 的派生重写（上游引擎的归属与文件范围见 [`COPYRIGHT.md`](COPYRIGHT.md)），因此 `LICENSE` 保留了上游的版权声明，并加上本工程自己的那一行：

```
Copyright (c) 2026 Yuxiang Lin
Copyright (c) 2026 youbaiyun
```

MIT 要求分发时随附版权声明与许可文本，所以这个文件必须跟着源码与扩展包一起走，不能删。
