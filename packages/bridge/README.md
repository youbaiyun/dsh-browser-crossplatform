# dsh-browser-crossplatform

The desktop half of the dsh browser extension 「dsh 浏览器扩展（全平台）」. It mounts a
token-authenticated WebSocket bridge on the desktop app's own webserver, exposes the
`browser_*` tools to the model, and relays image recognition to the model the user
configured.

Published as **`dsh-browser-crossplatform@0.38.5`**. Part of
[dsh-browser-crossplatform](https://github.com/youbaiyun/dsh-browser-crossplatform).
Install it into a dsh profile rather than by hand:

```sh
# from the registry
dsh plugin --profile desktop add dsh-browser-crossplatform

# or from a clone, with no registry involved
dsh plugin --profile desktop add link:<clone>/packages/bridge
```

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
