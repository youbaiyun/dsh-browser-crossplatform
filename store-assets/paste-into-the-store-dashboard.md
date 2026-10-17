# Copy for the store dashboard

Two fields. Paste from the blocks below. The English short description is asserted
equal to `_locales/en` character for character by
`extension/tests/locales.spec.ts`, so paste it from `store-listing.md` rather than
retyping it; the Chinese strings are translations and are not covered by that
assertion.

The dashboard is in Chinese, so the primary locale is Chinese: use the Chinese short
description and the Chinese detailed description. Keep the English pair for the English
listing if you add one.

## Short description — paste this (Chinese, the primary locale)

```
dsh 桌面端的浏览器执行器：模型以文本读取并操作你正在用的页面，保留登录态，不截图；看图功能可选，会把图交给桌面端配置的模型（默认 deepseek-flash）。
```

Length: 83 characters. The limit is 132.

## Detailed description — paste this (Chinese)

```
全平台 DeepSeek Harness 浏览器插件

完整项目skill+插件（要有完整项目才能正常使用）地址如下：
https://github.com/youbaiyun/dsh-browser-crossplatform

——————————————————————————————

让桌面端的 DeepSeek Harness（dsh）操作你正在用的浏览器标签页——
就在你当前这个页面里，保留你的登录态，不另开浏览器，不截图。

· 读页面：把网页转成结构化文本 + 带编号的控件清单，模型按编号操作。不截图。
· 看图（可选，默认关）：读你指定的那张图。扩展带着你的登录态去取它，所以登录后
  才可见的图也能读；不截图，也不整页拍图。
· 操作页面：点击、输入、滚动、跳转、管理标签页，只作用于你选中的那个页面。
· 确认开关：「不再询问，直接操作」出厂即开，所以新装的扩展点击和输入不会逐次弹确认；关掉它，就会改为审批，且可按站点信任、或只放开这一次连接。
· 密码和卡号不出页面：快照里就替换掉了，传出去的文本里没有。
· 网页不能冒充你：你在侧边栏打的每句话带来源标记，网页里写的带不上。
· 对话就在侧边栏：你说、它答。多步任务会先列出任务表，做完一条勾掉一条，每次工具调用占一行——
  没有仪表盘，也没有进度条。
**适配范围**：Windows / macOS / Linux 上的 dsh 桌面端（Node ≥ 20）+ 桌面 Chrome / Chromium / Edge **116+** 或 Firefox **140+**；**手机与平板不支持**（没有侧边栏这种界面）。
· 只连本机：扩展只连 127.0.0.1 上的 dsh，没有遥测。唯一例外是看图——你开启它并问某张
  图时，扩展会带着你的登录态去取那张图**本身**，再把字节交给桌面端。看图默认关闭。

需要先装好桌面端 dsh，并让它在同一台机器上运行。没有 dsh 时，侧边栏会
显示未连接，不会做任何别的事。

浏览器引擎极少部分来自 Lum1104/dsh-browser（现更名为 omdsh-dev/dsh-browser，MIT 协议）；侧边栏与交互层是本
版本自己的实现。
```

## English listing (only if you submit an English listing)

Short description:

```
Browser executor for the dsh desktop app: reads and operates your page, signed in, no screenshots. Image look-up: deepseek-flash.
```

Length: 129 characters, identical to `_locales/en` — copy it from `store-listing.md`
rather than retyping it, because a hand-written variant of the same length fails the
assertion in `extension/tests/locales.spec.ts`.

Name:

```
dsh Browser Extension
```

Chinese name:

```
dsh 浏览器扩展（全平台）
```

The full English detailed description is the last code block of `store-listing.md`.
