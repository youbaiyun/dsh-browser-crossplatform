# Chrome Web Store listing

Copy-paste source for the store form. The store takes plain text, so the blocks below are
written the way they should be pasted, not formatted for Markdown. Paste the block for the
locale you are submitting; do not paste this file.

Paste in this order: **Name**, **Short description**, **Detailed description**, then the
additional fields at the bottom.

---

## Locale: 中文（简体）— the primary locale

### Name

```
dsh 浏览器扩展（全平台）
```

### Short description (132 characters max)

```
dsh 桌面端的浏览器执行器：模型以文本读取并操作你正在用的页面，保留登录态，不截图；看图功能可选，会把图交给桌面端配置的模型（默认 deepseek-flash）。
```

Count: 83 characters.

### Detailed description

```
dsh 浏览器扩展（全平台）

有这个插件（桌面端 dsh + 浏览器扩展 + skill）可以做到：
（DeepSeek Harness 可以读到你的浏览器里的内容）
（DeepSeek Harness 可以操作你的浏览器）

没有这个插件（原版）：
（无法让 DeepSeek Harness 读到你浏览器里的内容）
（无法让 DeepSeek Harness 操作你的浏览器）

——————————————————————————————

可以用 AI agent 帮你下载完整项目 skill + 插件（要有完整项目才能正常使用）：
https://github.com/youbaiyun/dsh-browser-crossplatform
（把这个链接复制给 AI agent 帮你下载即可）

——————————————————————————————

· 需要先装好桌面端 dsh，并让它在同一台机器上运行。没有 dsh 时，侧边栏会显示未连接，不会做任何别的事。

**连接的前提：要先打开 dsh 才会开始连接。只打开浏览器是连不上的**——扩展本身不提供服务，它连的是本机上由 dsh 起的桥接。所以顺序是：先启动 dsh，再打开（或重新打开）侧边栏，状态才会变成已连接。

· 读页面：把网页转成文本 + 带编号的控件清单，模型按编号操作。不截图。

· 看图（默认关闭）：扩展带着你的登录态去取你问的那张图，交给 dsh 配置的模型识别，再据此操作页面。这一步比较慢，所以默认关着。

· 操作页面：点击、输入、滚动、跳转、管理标签页。默认只作用于你选中的那个标签页，切换或关闭其他标签页会明确列出。

· 确认开关：「不再询问，直接操作」出厂即开，所以新装的扩展点击和输入不会逐次弹确认；关掉它就会改为审批，且可按站点信任、或只放开这一次。

· 密码与卡号不出页面：快照阶段就替换成占位符，回显给模型的文本里没有它们。

· 网页不能冒充你：你在侧边栏打的每句话带来源标记，网页里写的字带不上。

· 对话就在侧边栏：可以快捷发送指令以及设置。

· 自带一份排障 skill（给 AI 看的说明）：侧边栏出问题时，让你的 AI agent 读这份 skill，它认得每一种症状——红点、页面名空着、工具超时、面板一片空白、审批不弹——并按步骤定位、给出修复，不用你自己去翻扩展内部。

· 只连本机：扩展只连 127.0.0.1 上的 dsh，没有遥测。唯一例外是看图——你开启它并问某张图时，扩展带着你的登录态去取那张图，交给 dsh 配置的模型识别。看图默认关闭。

适配范围：Windows / macOS / Linux 上的 dsh 桌面端（Node ≥ 20），配桌面 Chrome / Chromium / Edge 116+ 或 Firefox 140+。
手机与平板不支持：Chrome / Edge for Android 不支持安装第三方扩展，Firefox for Android 没有侧边栏界面。

——————————————————————————————

安全与隐私：

· 不采集、不上报：扩展没有自己的服务器，没有分析统计，没有遥测，只连本机（127.0.0.1）上的 dsh。

· 页面内容必须交给你配置的模型：你让它读或操作页面时，扩展把该页文本经本机 dsh 转交给你自己在 dsh 里配置的模型——这是它的功能本身。文本离开本机之后的处理，由 dsh 与你的模型服务商条款决定，不由扩展决定。

· 看图默认关闭：只有你开启它并问某张图时，扩展才去取那张图，并把图字节交本机 dsh 转给你配置的模型识别（默认端点 api.deepseek.com，用你自己的凭据）；关着时任何图都不读、不发。

· 密码与卡号不出页面：快照阶段就替换成占位符，回显给模型的文本里没有它们。

· 不做任何其他外发：除第 2、3 条外，扩展不会把页面内容发往任何别处。

浏览器引擎极少部分来自 Lum1104/dsh-browser（现更名为 omdsh-dev/dsh-browser，MIT 协议）；侧边栏与交互层是本版本自己的实现。
```

---

## Locale: 中文（繁體）— zh_TW

### Name

```
dsh 瀏覽器擴充功能（全平台）
```

### Short description (132 characters max)

```
dsh 桌面端的瀏覽器執行器：模型以文字讀取並操作你正在用的頁面，保留登入狀態，不截圖；看圖功能可選，會把圖交給桌面端設定的模型（預設 deepseek-flash）。
```

This one is **not** a hand translation: it is the string already shipped in
`extension/_locales/zh_TW/messages.json`, so the store listing, the extensions page and the
toolbar tooltip say the same thing.

### Detailed description

```
dsh 瀏覽器擴充功能（全平台）

有這個外掛（桌面端 dsh + 瀏覽器擴充功能 + skill）可以做到：
（DeepSeek Harness 可以讀到你瀏覽器裡的內容）
（DeepSeek Harness 可以操作你的瀏覽器）

沒有這個外掛（原版）：
（無法讓 DeepSeek Harness 讀到你瀏覽器裡的內容）
（無法讓 DeepSeek Harness 操作你的瀏覽器）

——————————————————————————————

可以用 AI agent 幫你下載完整專案 skill + 外掛（要有完整專案才能正常使用）：
https://github.com/youbaiyun/dsh-browser-crossplatform
（把這個連結複製給 AI agent 幫你下載即可）

——————————————————————————————

· 需要先裝好桌面端 dsh，並讓它在同一台機器上執行。沒有 dsh 時，側邊欄會顯示未連線，不會做任何別的事。

**連線的前提：要先開啟 dsh 才會開始連線。只開啟瀏覽器是連不上的**——擴充功能本身不提供服務，它連的是本機上由 dsh 起的橋接。所以順序是：先啟動 dsh，再開啟（或重新開啟）側邊欄，狀態才會變成已連線。

· 讀頁面：把網頁轉成文字 + 帶編號的控制項清單，模型按編號操作。不截圖。

· 看圖（預設關閉）：擴充功能帶著你的登入狀態去取你問的那張圖，交給 dsh 設定的模型辨識，再據此操作頁面。這一步比較慢，所以預設關著。

· 操作頁面：點擊、輸入、捲動、跳轉、管理分頁。預設只作用於你選取的那個分頁，切換或關閉其他分頁會明確列出。

· 確認開關：「不再詢問，直接操作」出廠即開，所以新裝的擴充功能點擊和輸入不會逐次彈確認；關掉它就會改為審批，且可按網站信任、或只放開這一次。

· 密碼與卡號不出頁面：快照階段就替換成佔位符，回傳給模型的文字裡沒有它們。

· 網頁不能冒充你：你在側邊欄打的每句話帶來源標記，網頁裡寫的字帶不上。

· 對話就在側邊欄：可以快速送出指令以及設定。

· 自帶一份排障 skill（給 AI 看的說明）：側邊欄出問題時，讓你的 AI agent 讀這份 skill，它認得每一種症狀——紅點、頁面名空著、工具逾時、面板一片空白、審批不彈——並按步驟定位、給出修復，不用你自己去翻擴充功能內部。

· 只連本機：擴充功能只連 127.0.0.1 上的 dsh，沒有遙測。唯一例外是看圖——你開啟它並問某張圖時，擴充功能帶著你的登入狀態去取那張圖，交給 dsh 設定的模型辨識。看圖預設關閉。

支援範圍：Windows / macOS / Linux 上的 dsh 桌面端（Node ≥ 20），搭配桌面版 Chrome / Chromium / Edge 116+ 或 Firefox 140+。
手機與平板不支援：Chrome 與 Edge for Android 不允許安裝第三方擴充功能，Firefox for Android 沒有側邊欄介面。

——————————————————————————————

安全性與隱私：

· 不蒐集、不回報：擴充功能沒有自己的伺服器，沒有分析統計，沒有遙測，只連本機（127.0.0.1）上的 dsh。

· 頁面內容必須交給你設定的模型：你讓它讀或操作頁面時，擴充功能把該頁文字經本機 dsh 轉交給你自己在 dsh 裡設定的模型——這是它的功能本身。文字離開本機之後的處理，由 dsh 與你的模型服務商條款決定，不由擴充功能決定。

· 看圖預設關閉：只有你開啟它並問某張圖時，擴充功能才去取那張圖，並把圖的位元組交本機 dsh 轉給你設定的模型辨識（預設端點 api.deepseek.com，用你自己的憑證）；關著時任何圖都不讀、不送。

· 密碼與卡號不出頁面：快照階段就替換成佔位符，回傳給模型的文字裡沒有它們。

· 不做任何其他外送：除第 2、3 條外，擴充功能不會把頁面內容送往任何別處。

瀏覽器引擎極少部分來自 Lum1104/dsh-browser（現更名為 omdsh-dev/dsh-browser，MIT 協議）；側邊欄與互動層是本版本自己的實作。
```

---

## Locale: English

### Name

```
DSH Browser Extension (All Platforms)
```

`(All Platforms)` is the counterpart of the Chinese `（全平台）`: each locale names the product
token (`dsh` / `DSH`) plus the same claim, in its own words. The claim is scoped by the detailed
description rather than by the name — the "Supported on" paragraph states Windows / macOS / Linux
with desktop Chrome, Chromium, Edge or Firefox, and then says plainly that phones and tablets are
not supported. Keep that paragraph: the name does not carry the scope, so the listing has to.

### Short description (132 characters max)

```
Browser executor for the dsh desktop app: reads and operates your page, signed in, no screenshots. Image look-up: deepseek-flash.
```

Count: 129 characters. Asserted equal to `_locales/en` character for character by
`extension/tests/locales.spec.ts`, so paste it from here rather than retyping it.

### Detailed description

```
DSH Browser Extension (All Platforms)

With this plugin (desktop dsh + browser extension + skill) you get:
(DeepSeek Harness can read what is in your browser)
(DeepSeek Harness can operate your browser)

Without it (the original setup):
(DeepSeek Harness cannot read what is in your browser)
(DeepSeek Harness cannot operate your browser)

——————————————————————————————

An AI agent can fetch the complete project — skill and extension both — for you (it only works with the full project installed):
https://github.com/youbaiyun/dsh-browser-crossplatform
(copy this link to your AI agent and ask it to download the project)

——————————————————————————————

· You need the desktop dsh installed and running on the same machine first. With no dsh running, the side panel shows "not connected" and does nothing else.

**Connection requires dsh to be started first. Opening the browser alone cannot connect** — the extension serves nothing itself; it connects to the bridge that dsh starts on this machine. So the order is: start dsh, then open (or reopen) the side panel, and the status becomes connected.

· Read the page: turns a web page into text plus a numbered list of controls, and the model acts by number. No screenshots.

· Look at an image (off by default): the extension fetches the image you asked about with your login state, hands it to the model dsh is configured with, and acts on the page from what it finds. This step is slow, which is why it ships off.

· Operate the page: click, type, scroll, navigate and manage tabs. By default it acts only on the tab you selected; switching to or closing another tab is always spelled out.

· The confirmation switch: "Don't ask again, act directly" ships switched on, so a fresh install does not prompt for every click and keystroke. Turn it off and approvals come back, with per-site trust or a one-connection-only allowance.

· Passwords and card numbers never leave the page: they are replaced with a placeholder inside the snapshot, so they are not in the text handed to the model.

· A web page cannot impersonate you: every line you type in the side panel carries a provenance marker; text written by the page cannot.

· The conversation is in the side panel: send instructions quickly, and change settings.

· Ships a troubleshooting skill (instructions written for an AI): when the side panel misbehaves, have your AI agent read it. It recognises each symptom — a red dot, an empty page name, tool timeouts, a blank panel, no approval card — and walks through the fix, so you do not have to dig inside the extension yourself.

· Talks to this machine only: the extension connects to dsh on 127.0.0.1 and nothing else, with no telemetry. The one exception is image look-up — when you switch it on and ask about an image, the extension fetches that image with your login state and hands it to the model dsh is configured with. Image look-up is off by default.

Supported on: the dsh desktop app on Windows / macOS / Linux (Node ≥ 20), with desktop Chrome / Chromium / Edge 116+ or Firefox 140+.
Phones and tablets are not supported: Chrome and Edge for Android do not allow installing third-party extensions, and Firefox for Android has no side panel.

——————————————————————————————

Security and privacy:

· Nothing is collected and nothing is reported: the extension has no server of its own, no analytics and no telemetry. It connects only to dsh on this machine (127.0.0.1).

· Page content must go to the model you configured: when you ask it to read or operate a page, the extension hands that page's text to the model you configured in dsh, through your local dsh — that is what it does. What happens to the text after it leaves this machine is governed by dsh and by your model provider's terms, not by the extension.

· Image look-up is off by default: only when you switch it on and ask about an image does the extension fetch that image and hand its bytes to your local dsh for the model you configured to read (default endpoint api.deepseek.com, using your own credentials). While it is off, no image is read and none is sent.

· Passwords and card numbers never leave the page: they are replaced with a placeholder inside the snapshot, so they are not in the text handed to the model.

· Nothing else goes out: apart from items 2 and 3 above, the extension sends page content nowhere else.

A very small part of the browser engine comes from Lum1104/dsh-browser (now renamed omdsh-dev/dsh-browser, MIT); the side panel and the interaction layer are this version's own implementation.
```

---

## Fields other than the descriptions

**Homepage URL** — the repository URL.

**Support URL** — the repository's issues page.

**Privacy policy URL** — a public URL for `PRIVACY.md` in this repository.

**Single purpose description** (required):

```
Operate the browser tab the user selects, on behalf of the dsh desktop app
running on the same machine.
```

**Justification for each permission** — see `permission-and-data-disclosure.md`.

## Store icon (128×128)

`extension/assets/icons/icon128.png`

## Screenshots (1280×800 or 640×400, at least one)

Not yet produced. Needed before submission. Take them with the panel open at a
realistic width:

1. A conversation in progress, with a tool line visible.
2. The settings sheet, showing the connection state.
3. An approval card, showing what is being asked and the allow/deny buttons — available after
   turning 「不再询问，直接操作」 off, since it ships on.

## The name is deliberately unlike upstream's

Upstream is `dsh Browser Control`. Two extensions sharing "dsh Browser …" leaves a user unable
to tell which one they want, and the store rejects a name that duplicates an existing listing.

## A note on writing the privacy claim

Two sentences in this file are load-bearing, and both are worded to say exactly what the code
does, because a store listing that promises more than the code delivers is a rejection risk —
and a privacy claim is the easiest place to over-promise:

- **"Page content must go to the model you configured."** Page text is the extension's whole
  purpose; a listing that says nothing is ever sent would contradict `PRIVACY.md` and the
  feature itself. The sentence names the destination instead of denying the transfer.
- **"Image look-up is off by default."** Recognition is the one thing that leaves the machine
  for a third party (the endpoint you configured, with your own credentials), so it is
  described as opt-in, and never as free — the default endpoint is a metered API billed to the
  account whose key dsh resolves.
