# dsh-browser-crossplatform

The desktop half of the dsh browser extension 「dsh 浏览器扩展（全平台）」. It mounts a
token-authenticated WebSocket bridge on the desktop app's own webserver, exposes the
`browser_*` tools to the model, and relays image recognition to the model the user
configured.

Published as **`dsh-browser-crossplatform@0.38.7`**; this tree builds **0.38.8**
(unreleased), whose `lib/` is self-contained. Part of
[dsh-browser-crossplatform](https://github.com/youbaiyun/dsh-browser-crossplatform).
Install it into a dsh profile rather than by hand:

```sh
# from the registry
dsh plugin --profile desktop add dsh-browser-crossplatform

# or from a clone, with no registry involved
cd <clone> && pnpm install              # build tooling only (TypeScript + tsdown)
pnpm --dir packages/bridge run build    # writes the self-contained lib/index.js
dsh plugin --profile desktop add link:<clone>/packages/bridge
```

A `link:` install only points the profile at the directory; it does not run this
package's install, and this build no longer needs it to: `lib/` bundles its
runtime dependencies (`schemastery`, `ws`, and the small `@deepseek-ai/*` helpers
it calls), so a directory with `lib/index.js` loads with no `node_modules` of its
own. Build it once with the two commands above (a clone carries no `lib/`). An
older, non-bundled `lib/` fails at load with `ERR_MODULE_NOT_FOUND: Cannot find
package '@deepseek-ai/cosmokit'` (reached via `schemastery`). `npm pack` ships the
same self-contained `lib` + `src` + declarations, so once 0.38.8 is published the
registry path needs no dependency resolution either (the registry still serves
0.38.7, whose `lib` is not bundled).

(the profile your desktop app runs is `desktop`; the CLI `dsh web` uses `web`)

Its settings page carries every knob, each with a one-line description; the full
list is the `Config` schema in `packages/bridge/src/index.ts`, transcribed in
`skills/dsh-browser-crossplatform-troubleshooting/SKILL.md`.

**适配范围**：Windows / macOS / Linux 上的 dsh 桌面端（Node ≥ 20）+ 桌面 Chrome / Chromium / Edge **116+** 或 Firefox **140+**；**手机与平板不支持**（没有侧边栏这种界面）。

Three things worth knowing before you enable anything:

- **The bearer token** is generated on first boot and persisted at
  `~/.dsh/ext-bridge-token` with mode 0600. `DSH_EXT_TOKEN` pins a fixed one.
- **Image recognition is off** until the user enables a tier in the extension's panel.
  When it is on, the extension fetches the image the user asked about and this plugin
  sends it to the model configured above; if that fetch fails, the extension sends the
  image's address instead and this side fetches it without the browser session.
- **The token-free path and the privileged gateway methods are loopback-only.** A
  non-loopback remote that presents a valid token can still use the ordinary session
  methods, which is what `dsh web --host` exists to serve.

MIT. The upstream notice is preserved in `LICENSE`.
