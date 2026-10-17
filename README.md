> 中文版见 [README.zh.md](README.zh.md)
# dsh-browser-crossplatform

An MV3 extension + bridge plugin that lets the dsh desktop app read and operate a browser tab: pages are handed to the model as **text**
(numbered actionable controls), and when image viewing is needed there is a separate **optional** channel, off by default. This is a derivative rewrite of [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser), restructured around two priorities — **high compatibility and trimming bloat** — while balancing stability with efficiency.

You can find this bridge plugin in the plugin marketplace under **`dsh-plugin`**, the marketplace's conventional topic tag.

What sets it apart from similar projects: **cross-platform** (Windows / macOS / Linux, zero platform branches in the source) · the root package has **zero dsh dependencies**
(the bridge declares all of dsh as peerDependencies) · **image viewing is optional and off by default** · one **unified version number** across the whole repository ·
and **benchmarks and CI that compare the extension against a local Playwright baseline in pairs**.

## Installation

Three routes — pick any one:

| What you want | Where to get it |
|---|---|
| **The extension in the browser** (side panel) | Browser extension store ([Chrome] (not yet listed) / [Firefox] (not yet listed)) |
| **The bridge plugin** (lets dsh talk to the extension) | This repository — [github.com/youbaiyun/dsh-browser-crossplatform](https://github.com/youbaiyun/dsh-browser-crossplatform). One command, see below |
| **Offline packages** (to load yourself / upload to the store) | The two zips under [Releases](https://github.com/youbaiyun/dsh-browser-crossplatform/releases) |

```sh
# From the npm registry (published: dsh-browser-crossplatform@0.38.7):
dsh plugin --profile desktop add dsh-browser-crossplatform   # the CLI dsh web uses --profile web

# Or straight from this repository, with no registry involved:
git clone https://github.com/youbaiyun/dsh-browser-crossplatform
dsh plugin --profile desktop add link:<clone>/packages/bridge
```

**Step-by-step foolproof instructions (including "how to confirm it is installed") are in [docs/INSTALL.md](docs/INSTALL.md).**

The extension itself is installed from the browser extension store (or load the unpacked build yourself following the build section below); the package above is the bridge plugin,
and its settings page lives inside dsh, titled 「dsh 浏览器设置」.

## Structure (five packages share the same version number `0.38.7`)

```
packages/protocol   zero-dependency wire protocol (frame validation, capability/authority split)
packages/bridge     dsh bridge plugin (WebSocket server + browser_* tools, runs inside dsh)
extension           the Chrome/Firefox MV3 extension itself
skills/             the troubleshooting skill your AI agent reads when the panel misbehaves:
                    one symptom → one section → a repair, without the user opening devtools
```

## Compatibility range (all targets and minimum versions)

| Target | Minimum version | Where this number comes from |
|---|---|---|
| **Operating system** | Windows / macOS / **Linux** — all supported (CI is Linux, so it is verified the most thoroughly) | The platform-specific code is confined to one place, `packages/bridge/src/browser-launch.ts`, which has to know where each platform keeps its browsers and profiles; build/benchmark tooling adds the Windows `.cmd` shim. Everything else is platform-neutral. CI's `ubuntu-latest` **is Linux**, and the full chain runs on it for every commit |
| **dsh desktop** | **any `0.2.x`** — declared as `>=0.2.0-rc.2 <0.3.0` and **optional**, verified against `0.2.1-rc.2` | dsh is the host and provides these packages at runtime, so the bridge declares them as **optional peers** with a range, never an exact pin. The range documents the supported line; `optional` is what actually keeps a host on a prerelease (`0.2.1-rc.2`, the current desktop release) installable, because semver's prerelease rule excludes such versions from every `0.2.x` range — `*` and `0.2.x` included. The runtime gate is a capability check (`gateway.wireStream`); a genuinely missing service fails loudly by name, and a missing agent registry degrades to a no-op |
| **Node** | **≥ 20** | `engines.node` in the root, bridge and extension manifests (the protocol package declares none, because it is a private workspace package with no scripts to run) |
| **Desktop Chrome / Chromium / Edge** | **116** | `minimum_chrome_version` in `extension/manifest.json` |
| **Desktop Firefox** | **140.0** | `gecko.strict_min_version` in `extension/manifest.firefox.json` |
| **Panel UI** | Chrome uses `side_panel`, Firefox uses `sidebar_action` | Both point at the same `control/index.html` |
| **Build/test (development)** | Node **22** + pnpm **11** | `.github/workflows/check.yml` |
| **Phone / tablet** | ❌ Not supported | See below |

The bridge has only `ws` and `@deepseek-ai/schemastery` as runtime dependencies, and both are platform-independent; the extension bundles its two panel-only dependencies (`marked`, `dompurify`) into the build.
CI builds both browser targets and runs the full test suite (including end-to-end cases that actually launch Chromium);
Windows has been verified locally; macOS is not covered by CI, but it is POSIX like Linux and the platform-specific surface is that one module.

**The loopback shortcut is bound to named extension ids.** The bridge normally authenticates with a bearer token, but a loopback upgrade from the extension itself skips it so discovery stays zero-config. That exemption is not "any `chrome-extension://` origin" — every other extension on the machine has one of those too — but an exact match against `extensionId`, a comma-separated list whose default names two ids: `kdhkdgfcinfkmogifamoapmheihhcjfk`, which this repository's manifest `key` produces, and `agpipnjijkpomaannkijkilggoffdiaf`, which the Chrome Web Store assigned. Both are needed because the store refuses a manifest carrying `key`, so a development load and a store install present different origins. Add your own id to the list for a build of your own, or set `extensionId: ''` in the plugin config to require the token on every connection, including loopback.

**Why phones and tablets are not supported**: Chrome / Edge for Android does not support third-party extensions;
Firefox for Android has no side panel UI; and the bridge is **loopback-only where it matters** — the
token-free path and the privileged gateway methods (`host.pickDirectory`, `host.openPath`, `settings.*`,
`credentials.*`) are both gated on a loopback remote (`packages/bridge/src/server.ts`), and a phone would be
connecting to `127.0.0.1` on a different machine. A non-loopback remote with a valid token can still use the
ordinary session methods that `dsh web --host` exists to serve; what it cannot do is reach the privileged ones.
## Key differences from the original

| Dimension | Original | This version |
|---|---|---|
| Version | Root 0.2.1 / extension 0.3.1 / bridge 0.0.7, each drifting independently | Unified `0.38.7` — root package, protocol, bridge, extension and both manifests all agree |
| Node | `^22.19 \|\| >=24` | `>=20` |
| TypeScript | Split between extension 5.6 and bridge 6.0 | One toolchain; the extension's declared range is `^5.6`, the bridge's and the protocol's `^5.7`, and the lockfile resolves a single installed version |
| Dependencies | 35 `@deepseek-ai/*` (RC) in the root package, node_modules at 600 MB | **0** dsh dependencies in the root package (its tests and typecheck are pure Node + a bundled tsc); the bridge ships with only `ws` + `@deepseek-ai/schemastery` and declares all of dsh as `peerDependencies` (at runtime it probes the host via `ctx.get()`, and bundles nothing); the extension has two panel-only runtime dependencies (`marked` + `dompurify`), both bundled into the panel build |
| Bridge hard-deps | React peer + 3 web-side `dsh-client-ui-*`/`locale` peers + a `dsh.client` injection block | **All removed** (the extension panel is self-contained and injects no UI into dsh's web client) |
| Bridge protocol | Its own `protocol.ts` (12.7 KB), with a separate copy in the extension | Shared `@dsh-browser/protocol`, inlined into both artifacts by the bundler |
| Bridge redundancy | Plus a web-side `client.js` (7.2 KB) | Deleted |
| Injection | the manifest's global `content_scripts` inject into every iframe on every site | Same global `content_scripts` declaration (the extension cannot know in advance which tab you will point it at), but **bounded at the other end**: only the tab you bound is read or operated, and `chrome.scripting` re-injects on demand into tabs that predate the install. See `docs/TRUST-MODEL.md` ("broad injection, narrow authority") |
| Browser minimums | Chrome 116 / Firefox 140 | Same requirements as upstream, not relaxed (Chrome 116 / Firefox 140) |
| Build | 3 vite configs + shared + build.mjs (5 files) | The same shape, deliberately: one `build.mjs` sequences the three targets, and `vite.shared.ts` holds what they share. What changed is that the config list lives in one script instead of being documented in three places |
| Test runner | vitest + jsdom | vitest (jsdom environment for the extension panel, node environment for the bridge) |

## Core mechanisms

- **Text snapshot + action execution**: no screenshots, no recognition step (at the protocol layer, `textOnly: true`). Pages are rendered into structured text: title/URL/body (readability-lite) + a numbered interactive inventory (including ARIA role controls) + form fields (including `masked`/`checked`/`required`), with support for `delta` diffs and `region` partial snapshots.
- **Safety invariants**: the values of sensitive fields (`type=password`, `autocomplete=credit-card|cc-*`, id/name/aria-label matching `password|passwd|credit|card|cvv|cvc|secret|pwd`) are always masked as `••••`; **the accessible name never uses the input's current value** (only the value of submit/button/reset inputs counts as a name), and unit tests enforce this.
- **Tool surface (17)**: `browser_snapshot` / `click` / `type` / `press` / `scroll` / `navigate` / `open_tab` / `list_tabs` / `follow_tab` / `close_tab` / `back` / `forward` / `reload` / `get_text` / `wait` / `launch` / `describe_image`. Full parameter list: `delta`/`region`/`replace`/`amount`/`selector`/`ms`/`active`/`tabId`/`index`/`text`/`key`/`direction`/`url`, plus `frame` on the 7 frame-scoped tools. `browser_describe_image` answers only while recognition is on; `browser_launch` is the one tool that runs on the desktop side, because it is the only one that can work with no browser running.
- **Starting a closed browser (`browser_launch`, and before every tool)**: tool execution lives in the extension, so with the browser closed there is nothing to dispatch to — the tools used to fail with a bare `bridge-closed`. Now a call with no connection first tries to start the browser and then reports what actually happened. It launches **the browser you already use**: the executable comes from the platform's own record of which app opens a link (the Windows `UserChoice` registry entry, or macOS LaunchServices), falling back to detection, and there are **no extra flags** — no `--user-data-dir` (that would be a second browser with none of your tabs or logins) and no `--load-extension`. If that browser is **already running with a window, nothing is launched at all** (a second start would only open a window in the existing process while discarding the flags), and the answer says which browser to enable the extension in. `browserUserDataDir` + `extensionPath` exist for the development case, a named profile where an unpacked build is genuinely loaded.
- **What it cannot do**: install the extension. A command-line load lasts one session and installs nothing — closing the browser loses it — and since Chrome 137 branded Chrome/Edge builds ignore `--load-extension` altogether (Chromium and Chrome-for-Testing still honour it). So the extension has to be installed in the profile once (store, or "load unpacked" on the extensions page), and after that a normal start reconnects by itself. The bridge checks `<profile>/Extensions/<id>` in Chrome/Edge/Brave/Chromium profiles and says plainly which of the two situations the user is in rather than offering a step that cannot help.
- **Frame routing**: a snapshot combines the main frame with all accessible iframes, and subframes are labeled `[frame N] <origin>`; the background remembers `N → frameId` and routes later tools carrying `frame` to the same frame; each frame renders its section within the same negotiated budget, and the body is truncated first (`mainBudget = maxChars × 0.5`) so a long page cannot swallow the inventory.
- **Capabilities added beyond upstream** (additions, not removals): `browser_type` can fill a `<select>` (matching in order by option value → visible label → 1-based index, listing the available options on failure) and set a checkbox/radio with true/false; `browser_wait` supports wait conditions (`selector` / `text`, failing with the `timeout` error code if they never appear) instead of only a fixed delay.
- **Automatic snapshot after navigation**: the content script announces when the new document is ready (the equivalent of the original's `DSH_CONTENT_READY`), and after navigation-class actions (navigate/back/forward/reload) the background performs the handshake, waits for the new document and snapshots automatically, pushing the result to the panel — the model does not need another round trip.
- **Image manifest (useful even with image viewing off)**: the ported pipeline originally **discarded bare `<img>` elements entirely** — images are not in the interactive selectors, and `innerText` carries no `alt` either. Now an `Images:` section is added at the end of the snapshot: in document order, grouped by the nearest heading, each line rendered as `[N] kind WxH "label" near="…" text-described [unavailable] → src ⟦iN img:state⟧` (`content/snapshot.ts`, `renderImage`). `N` is the same interactive index the inventory uses, so the number in the section is the number to `browser_click` (for the images that are clickable at all); `text-described` marks an image whose author already supplied text, and the trailing marker carries the recognition state so the section and the inline marker always agree. Positional information comes from the DOM, so the model never needs coordinates. The marker is nonce-escaped, so a page cannot forge the section or the state it carries.
  **Image types covered**: `<img>` (including `currentSrc`, so a `srcset` candidate is reported rather than the fallback), `<video poster>` (the cover is an ordinary image URL and goes through the same fetch path), inline `<svg>` (no bytes to fetch, so it is reported as `kind=svg` and never handed to the fetch path), and CSS background images — inline `background-image` declarations are collected exactly, while class-declared ones go through a **bounded computed-style scan**: every element in the region is visited until `BACKGROUND_SCAN_LIMIT` (1500) elements or `MAX_BACKGROUND_IMAGES` (20) background images, whichever comes first, with elements already collected as img/svg/video and `script`/`style` tags skipped. `<canvas>` is **not** collected: a canvas has no address to fetch, and reading it back would mean reading page memory, so it is left out rather than listed as unreadable.
  **Rendering happens against the background's answers**: the content script collects the images and hands back `ImageView[]` out of band, and it renders the `Images:` section from those views while the background holds the recognition results and the cache — because recognition is asynchronous, the background is the side that knows the answer and fills each marker's state afterwards. Each iframe renders its own section, so the indices are frame-local. **The budget is the item budget, not a second one**: images are capped at a third of `maxItems` (floor 4) and share the interactive inventory's numbering and cap, so a sixty-thumbnail page cannot crowd out the controls (`content/snapshot.ts`, `imageCap`).
- **Image fetching and recognition cache (background)**: `background/image-fetch.ts` fetches images **inside the service worker** — the extension context holds host permissions, so it can read cross-origin image bytes directly that a content script could never read (a content script canvas would be tainted); it passes `credentials:'include'` to cover media behind a login. It **does not decode, resize or re-encode**: it returns the bytes as they are, or says why it could not, and a body over `MAX_IMAGE_BYTES` (4 MB, since base64 inflates by a third and the payload crosses the WebSocket) is not carried inline — the caller falls back to handing the URL to the desktop. Failures are **classified rather than thrown** (`too-large` / `unsupported-url` / `fetch-failed` / `empty`, with a `permanent` flag for the ones that cannot succeed later in the session), because the model must be told "there is an image here, but it cannot be read" rather than seeing nothing at all. `background/image-cache.ts` caches results and failures by **image identity (URL)**, persisted to `chrome.storage.local` for up to 24 hours with the 200 most recent descriptions kept and transient failures retried at most twice — the cache exists for consistency first (the same logo in thirty rows must not yield thirty different sentences) and for cost second, and it is not memory-only because the MV3 worker is stopped and restarted freely. `background/vision.ts` **is where the recognizer plugs in**: direct-to-cloud and via-desktop-bridge differ only in that one injected function, while fetching/caching/rendering are exactly the same.
- **Two recognition transports, desktop relay preferred**: the protocol adds an `image.call` / `image.result` frame pair, and `hello.ok`'s policy gains `imageRecognition`. The extension fetches the image itself first (only it carries the login state) and sends the bytes down with the frame; when it cannot, it hands the URL to the desktop, which fetches with a network stack unconstrained by CSP/host permission/enterprise policy — that is the real value of desktop relay, and why the frame carries a `source` field instead of one fixed type. On the desktop side `vision.ts` calls the configured chat-completions model (`deepseek-flash` by default, images as data URLs, `thinking` off, `usage` read back to confirm the setting took effect), and `image-relay.ts` fetches the bytes or falls back to the URL and classifies failures. Credentials stay on the desktop: `hello.ok` reports `imageRecognition: false` when no vision client could be built, which happens when neither `visionApiKey` nor the desktop's own `DEEPSEEK_API_KEY` credential resolves. `background/vision.ts` picks the transport per request: **the desktop relay wins whenever the desktop advertised it**, and the extension's own direct path is used otherwise.
- **Direct external API connection (the recognition step is invisible in the UI)**: `background/vision.ts` (`DirectRecognizer`) lets the extension call the external API itself, reading its configuration from `chrome.storage.local` (`visionEndpoint` / `visionApiKey` / `visionModel`; the timeout and the `thinking` switch exist only on the desktop-side plugin config), and **adds no UI at all** — the panel shows the image-viewing tier and nothing else about recognition. A real failure (429 etc.) is final rather than falling through to the other transport, so you never pay twice for the same image. The vision-only settings live in `src/settings.ts` next to the rest, and the panel never exposes them. Key guarantee: **this recognition step creates no session, writes no file and produces no conversation entry** — it is just an ordinary outbound call in the background; the description memo goes to `chrome.storage.local` (24-hour TTL). Both paths share the same prompt and parser in `protocol/src/vision-contract.ts`, so which side calls the model changes neither the question asked nor what counts as a valid answer.
- **Panel markdown**: model replies are rendered with `marked` and sanitized with `DOMPurify`; during streaming the reply stays plain text (avoiding re-parsing on every frame) and is rendered once it is complete; links in replies open in a new tab without leaving the panel.
- **Approval confirmation**: state-changing actions can ask the user first (the `unrestrictedBrowserAccess` switch, trusted origins, allow-once). The switch **ships on**, so a fresh install is not asked; turning it off restores the prompts. While it is on it also overrides the page-sharing choice, so "ask before reading the page" does not apply.
- **On-demand injection**: no manifest `content_scripts` is *required* for the controlled tab — scripts are injected with `chrome.scripting` into the controlled tab and re-injected after navigation; the manifest's declaration exists so that a tab open before the extension was installed or reloaded is already covered.
- **Tab affinity**: tools are bound to a single controlled tab. What a manual tab switch does is the follow-tab setting: `follow` (**the shipped default**) moves the binding to the tab you went to, `ask` blocks and asks whether to keep the current tab or follow, `keep` stays put.
- **Session bridging**: panel prompts are sent to the desktop dsh via `rpc` frames, and assistant text streams back.
- **Bridge plugin**: a token-authenticated WebSocket on `/ext/bridge`, a `hello` handshake negotiating caps/policy, `browser_*` tools dispatched to the extension as `tool.call` frames, and privileged gateway methods always rejected for non-loopback remotes.

## Image viewing (recognition)

There is only one switch in the UI: panel → settings → **image viewing** (off / low / standard / enhanced). It is **off** by default; once it is on, the image you ask about does leave this machine for whichever model is configured (see below).

**Where the calls go** is deployment configuration, not a setting — the panel shows the image-viewing tier and nothing else about recognition, so the endpoint, model and key are set by whoever deploys it (the desktop plugin config, or extension storage). The panel's tests hold that line: `extension/tests/control-page.spec.ts` asserts it exposes no control the browser cannot honour, and the tier select is the only recognition-related field it renders.

**Desktop relay (recommended)**: in the desktop profile's `cordis.patch.yml`, add a config key to the bridge plugin; the address and model already have defaults (`https://api.deepseek.com/v1` / `deepseek-flash`), and thinking defaults to off:

```yaml
- id: bridge-browser
  disabled: false
  config:
    visionApiKey: <key>
    # Optional; the id must be the API id, not the display name —
    # `deepseek-flash`, never `DeepSeek-V4.1-Flash` (the API rejects that with 400).
    visionModel: deepseek-flash
```

**Browser direct**: there is no UI entry point; just write the settings into extension storage for your deployment (the manifest's `connect-src` already allows `https:` and `http:` for any host, so no manifest edit is needed):

```js
chrome.storage.local.set({ dshSettings: { visionEndpoint: 'https://…/v1', visionModel: '…', visionApiKey: '…' } })
```

`tools/vision-stub.mjs` and `tools/vision-proxy.mjs` are development tools: the former measures local overhead, the latter lets the extension go to the cloud without changing the manifest. Normal use does not need them.

## Commands

```sh
pnpm install
pnpm -r run typecheck   # typecheck the whole repo (protocol + bridge + extension)
pnpm -r run test        # all unit tests (the bridge's e2e needs a Chromium; see below)
pnpm --filter dsh-browser-extension run build           # Chrome → extension/dist
pnpm --filter dsh-browser-extension run build:firefox   # Firefox → extension/dist-firefox
pnpm --filter dsh-browser-extension run build:store     # Chrome, no manifest `key` → extension/dist-store
pnpm --filter dsh-browser-extension run build:store:firefox  # Firefox, no `key` → extension/dist-store-firefox
pnpm --filter dsh-browser-extension run package         # all archives → repo root
pnpm --filter dsh-browser-crossplatform run build  # bridge plugin → packages/bridge/lib
```

`package` writes up to four archives — the two development ones always, and the two `-store`
ones when those builds exist — naming each after the manifest inside it and refusing `\`
entry names (which the stores reject). It reads the version out of `dist/manifest.json` and
`dist-firefox/manifest.json`, so both development builds must run before it will start. **Upload the `-store` archive to a store, not the other one**: the plain
builds carry a manifest `key` that pins the extension id for development, and the Chrome
Web Store refuses an upload that contains it. See [docs/STORE.md](docs/STORE.md) for the
full submission path, including what the store-assigned id means for the bridge. To run
the bridge's e2e locally, give it a browser that still honors
`--load-extension`: `node benchmark/lib/browser-install.mjs chromium`, then set
`PLAYWRIGHT_CHROMIUM_PATH` to what `node benchmark/lib/chromium-path.mjs` prints.

## End-to-end benchmark (benchmark/)

A benchmark that turns "efficient" from an adjective into a number: the same model, the same profile, the same set of tasks, the same machine, **comparing two browser execution backends** — `playwright` (the runner's built-in baseline plugin) and `extension` (this repository's real bridge + the built extension). The baseline exposes the eight tools the six tasks actually need (`snapshot`, `click`, `type`, `press`, `scroll`, `navigate`, `get_text`, `wait`); the product exposes seventeen, so the comparison measures the same tasks rather than an identical surface.

Six tasks cover the basic patterns of a browser agent (read / single step / form / search / multi-step / dynamic loading), with variations chosen by **seed** to prevent overfitting, running against the fixture site in `benchmark/site/`. Each task records four numbers: **success rate** (a 120-second timeout counts as failure), **completion time** p50/p90/mean (from the model receiving the task to the end of the DSH turn), **average number of tool calls**, and **average prompt tokens**.

Why it must be run in pairs: absolute time is dominated by the model (generation is about half of it), and only a comparison can isolate the backend's own contribution.

```sh
pnpm --dir benchmark install-browser          # download the Chrome for Testing matching playwright-core in the lockfile
node benchmark/run.mjs --dry-run --smoke      # infrastructure check, no model call
node benchmark/run.mjs --smoke                # one real model call (spends quota)
node benchmark/run.mjs                        # the real run: 6 tasks × 5 seeds × 2 backends = 60 runs
node benchmark/run.mjs --tasks order_lookup,contact_form --seeds 1-5 --trials 2
```

Three prerequisites; miss one and it will not run:

1. **A dsh command line that accepts `--profile web --patch … -- --no-open --port N`** — the upstream repository treats `@deepseek-ai/dsh` as a dependency, so `pnpm exec dsh` is directly available there; **this rewrite is a standalone workspace without that dependency** (the bridge is installed into the desktop profile), so you must point at it yourself: `BENCHMARK_DSH_COMMAND="node D:/path/to/dsh.mjs"`.
2. **On Windows, use `pnpm.cmd`** — a global install provides `pnpm` / `pnpm.cmd` / `pnpm.ps1` at the same time, while `child_process.spawn` can only execute the first two, and Node 18+ additionally requires `.cmd` to go through a shell. The script already handles both cases, and reports the command it actually used in the failure message.
3. **Chrome for Testing or Chromium** — recent Google Chrome Stable builds ignore `--load-extension` and cannot serve as the automated benchmark browser for the extension backend.

`benchmark/tests/` holds the benchmark tool's own unit tests (`node --test tests/*.test.mjs`, needing neither a model nor a browser).

## Status

All four capabilities are now complete, plus the image manifest section, background image fetching/caching, direct external API connection and desktop-relayed recognition. The table below lists each test suite; **the exact counts are whatever `pnpm -r run test` outputs** (the numbers previously hard-coded here have drifted twice already, so they are no longer hard-coded).

| Capability | Implementation | Verification |
|---|---|---|
| Content pipeline (equivalent to the original, plus additions) | Full port of `extract` / `privacy` / `ids` / `snapshot` / `actions`: accessible-name precedence, sensitive-field masking, forms array, ARIA roles, stable ids, delta, region; plus `<select>`/checkbox filling, `browser_wait` wait conditions, and the `Images:` image manifest section | jsdom tests (including safety-invariant assertions) |
| Frame routing | `[frame N]` numbering + an `N → frameId` routing table, each frame rendering within the same negotiated budget | 5 unit tests (`frames.spec.ts`) |
| Automatic snapshot after navigation | Content-ready announcement (equivalent to `DSH_CONTENT_READY`) + background handshake + automatic snapshot pushed to the panel after navigation | Verified together with e2e and both builds |
| Panel markdown | `marked` + `DOMPurify`, plain text while streaming / rendered once complete, link interception | Both builds pass |
| Bridge plugin test suite | Full migration of the original specs (vitest) | 17 spec files, one of them the e2e |
| End-to-end | Playwright loads the built extension + a real BridgeServer: zero-config discovery → caps negotiation → `session.create`/`prompt` | Runs in CI (Playwright's own Chromium honours `--load-extension`); it self-skips where no such browser exists, so check the log rather than the exit code |
| Browser launch path | A second BridgeServer plus a browser started through `browser-launch`, so "the browser was closed" has a tested answer | `packages/bridge/tests/browser-launch.spec.ts` (unit, injected effects) and one opt-in e2e (`DSH_E2E_COLD_START=1`, because it starts a real browser) |

Test runner: **the protocol uses Node's built-in `node --test`**; **the extension and bridge use `vitest`** (the bridge suite was migrated from the original as-is, without rewriting the assertions).
The "matches the store listing copy" check in `locales.spec.ts` compares the English short description with `store-assets/store-listing.md` whenever that file is present — which it is in this tree, so the assertion runs (it also enforces the 132-character limit on all three locales).
e2e needs a browser that still honors `--load-extension` — Playwright's Chromium works, while branded Chrome/Edge 137+ removed that switch; the suite is skipped automatically when the browser or `extension/dist` is missing. `PLAYWRIGHT_CHROMIUM_PATH` can point at a specific browser.

### Layering principle (why the code lives where it does)

- **Pure logic separated from wiring**: validating incoming data, generating the approval copy shown to the user, encoding bytes, parsing frame numbers and combining cross-frame snapshots — these are pure, so they live in unit-testable modules (`background/tools.ts` for dispatch and frame routing, `background/authorization.ts`, `background/frames.ts`, `background/image-fetch.ts`). The wiring stays in `background/index.ts`.
- **The composition root is testable too**: each spec that loads `background/index.ts` installs a sufficient `chrome` API stub through `vi.stubGlobal` (see the `mockChrome` helper at the top of `tests/background-tools.spec.ts`), which brings the **wiring itself** under assertions such as "every event has a listener", "content-ready gets a reply" and "ports that are not the panel are ignored".
- **Types and guards from one source**: `tabSwitch` is parsed by `isTabSwitchMode` exported next to the `TabSwitchMode` union in `background/tab-affinity.ts`, and every stored setting is normalized through one `normalizeSettings` in `settings.ts` against `SETTINGS_DEFAULTS` — so adding a panel control but forgetting to teach the background to accept it is a bug the parser shows up rather than a silent no-op.
- **Cost guarantees can be verified**: `visionThinking: off` cannot be proven to take effect from the request body (a provider may silently ignore it), so at startup it sends a single 1×1-pixel image as a self-check and **reads `usage` back**; it warns only if reasoning tokens actually appear, and stays quiet otherwise (no false alarms).
- **Unused imports/parameters are errors**: `tsconfig.base.json` enables `noUnusedLocals` + `noUnusedParameters`, so this kind of rot can no longer accumulate silently.
- **No sharing of small utilities across packages**: a three-line type guard like `isRecord` is duplicated in the protocol package and the bridge package, because turning the wire-protocol package into a general-purpose toolkit is not worth it.
- **What the model is told matches what runs**: two capabilities were advertised in the tool schema long before the executor implemented them — filling a `<select>`/checkbox and waiting on a condition — so both are now implemented in `background/tools.ts`'s counterpart (`content/actions.ts`) and pinned by `extension/tests/actions-form-controls.spec.ts`. A schema that promises a behaviour is a bug report against the executor.

`extension/src/content/images.ts` is the collection half of the `Images:` section (it takes part in every build); its grammar, including that a page cannot forge a section line, is pinned by `extension/tests/markers.spec.ts` and `extension/tests/annotate.spec.ts`.

TODO (out of scope for this goal): `background/index.ts` can be split further; the bridge's `composition.spec.ts` (4 cases, real Loader) and `session-purge.spec.ts` (12 cases) have not been migrated, and would need about 15 more dsh packages added as devDependencies.

**Prompt-injection invariant, now asserted**: the prompt section assembled for the model must remain pure ASCII, so a page has no homoglyph that could pass its text off as the browser panel speaking. The two halves are exported constants (`BROWSER_PROMPT_PREAMBLE` / `BROWSER_PROMPT_MARKER_RULE` in `packages/bridge/src/index.ts`), and `packages/bridge/tests/index.spec.ts` fails if either grows a non-ASCII character or starts quoting the marker itself.

**Identity invariants, also asserted**: the bridge's token-free path is bound to named extension ids, and tests keep that binding honest from both directions — `packages/bridge/tests/extension-identity.spec.ts` recomputes the id from `extension/manifest.json`'s `key` and compares it with the first entry of `DEFAULT_EXTENSION_IDS` (skipping when the extension is not a sibling, as in a standalone npm install), checks that both of this project's ids are listed by default, and checks that an unlisted id, a prefix of a listed one, another scheme, and an empty configuration are all still refused; `packages/bridge/tests/origin-gate.spec.ts` pins the predicate that only a listed exact Origin may skip the token. `extension/tests/versions.spec.ts` keeps the five package versions equal (root, protocol, bridge, extension and the benchmark harness, plus both manifests), and `node extension/scripts/extension-id.mjs` prints what a build's key actually derives, for checking by hand.

## License

MIT. This project is a derivative rewrite of [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser) (for the upstream engine's attribution and file scope see [`COPYRIGHT.md`](COPYRIGHT.md)), so `LICENSE` keeps the upstream copyright notice and adds this project's own line:

```
Copyright (c) 2026 Yuxiang Lin
Copyright (c) 2026 youbaiyun
```

MIT requires the copyright notice and license text to accompany distribution, so this file must ship with the source and the extension package and cannot be removed.
