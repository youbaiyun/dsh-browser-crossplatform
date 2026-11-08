# Changelog

This project is a derivative of  
[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser). Upstream releases  
are listed only where this fork has something to say about them; see  
[COPYRIGHT.md](COPYRIGHT.md) for which files belong to whom.

Two builds exist today, and only these two are described here:

| Build | Version | Extension id |
|---|---|---|
| Chrome Web Store / packaged | **0.38.7** | `agpipnjijkpomaannkijkilggoffdiaf` |
| unpacked from this tree (`extension/dist`) | **0.38.8** | `kdhkdgfcinfkmogifamoapmheihhcjfk` |

They share the wire format, but the store build is the `0.38.7` code: every fix
listed under `0.38.8` below is absent there. Everything older is out of scope.

## [0.38.8]

The current tree. The fixes below fall into three groups: the Host Peer fix that
made the panel useless on desktop `0.2.2`, a per-Session history queue, and the
2026-11-07 field-report fixes; on top of them the built `lib/` became
self-contained.

### Fixed

- **Unary gateway calls now carry the same Host Peer as the Remote streams.** All four
  `gateway.invoke` sites in `packages/bridge/src/remote-host-api.ts` pass
  `peer: this.wirePeer.peer` — the generic RPC dispatch, `session.history`'s `page`, and
  `session.models`' `modelCatalog` and `projections`. Without it the panel said 「已连接」
  while every unary call died with
  `Cannot read properties of undefined (reading 'signal')`, because the Host's
  `prepareInvocation` starts with `assertPeerLive(request.peer, endpoint)`.
  `session.create` / `session.history` answer `ok:true` through the session-deferral
  layer, which is why this looked like a model error rather than a bridge one.
  `TypertGatewayLike.invoke`'s request type accepts `peer?: PeerLike | undefined`, so the
  borrowed-`browserPeer` case stays valid.
- **Overlapping `session.history` reads of the same Session no longer abort each other.**
  A history read opens `session/follow`, and the Host keeps a single active follow per
  session, so five concurrent reads returned two snapshots and three
  `gateway/cancelled` errors. `oneShotSessionSnapshot` now serializes per Session and
  retries once when the stream was cancelled by the Host (never when the caller aborted).

### Fixed (field report, 2026-11-07)

A 13-item report against desktop `0.2.2-rc.1` + extension `0.38.7` (store id, Chrome 155)
turned up one class of bug the unit tests could not see — the tab the tools talked to was
not the tab the panel showed — plus a set of consistency gaps in what the model is told.

- **Explicitly followed / background-opened tabs stay the tool target in `follow` mode.**
  `browser_follow_tab` and `browser_open_tab{active:false}` succeeded, then every tool read
  the visible tab instead, and `browser_open_tab` even failed with
  `The controlled tab changed during the operation…` after the tab had been created.
- **The extension reconnects after a browser restart.** There was no
  `chrome.runtime.onStartup` listener, so after restarting the browser (or the desktop app)
  the service worker was not woken until the side panel was opened by hand. `onStartup` now
  re-arms the keepalive alarm and starts the bridge by itself.
- **A click that navigates is reported as navigation, not a dead content script.** When the
  document was replaced mid-dispatch, the tool returned 「content script stopped responding」
  although the navigation had happened. It now waits for the replacement document, snapshots
  it, and never re-dispatches the click (a second dispatch could click twice).
- **`press Enter` submits forms again.** The old code fired a synthetic `submit` event, which
  never runs the form-submission algorithm; it now calls `form.requestSubmit()` (or clicks a
  submit button), and honours `preventDefault()` on the keydown.
- **Sensitive query parameters are masked in snapshots.** `?pwd=`, `token`, `sig`, `api_key`,
  `otp`, … are replaced with `***` in the page URL, the delta header, link `href`s and image
  `src`s, while harmless parameters such as `user=alice` are kept.
- **Body text outside `<main>` is no longer dropped.** The readability container used to lose
  the heading/lede outside the main region (and the delta then said “(No visible changes.)”
  while `wait(text=…)` had matched). Surrounding text is now rendered before the main region,
  skipping page chrome (`nav`/`aside`/`footer`/`script`/`style`/…), and delta sees those
  changes.
- **`navigate` / `back` / `forward` / `reload` now attach the new page snapshot**, matching
  the README's promise and the content-script path, instead of only saying “Call
  browser_snapshot again…”. Injectability is judged from the destination URL, so
  `chrome://`/PDF destinations do not wait out the navigation timeout.
- **`region` scopes the interactive inventory and images**, not just the body text.
- **CSS background images are listed under `Images:`** alongside `<img>` and inline SVG
  (gradients and tiny boxes stay out); the case was already implemented, so this became a
  regression test rather than a code change.
- **`<style>` / `<script>` source never leaks into page text**, including inside inline SVG
  where the element is not an `HTMLElement`.
- **Minimized windows no longer mark every element `[outside viewport]`** — a 0×0 reported
  viewport means “unknown”, not “nothing is visible”.
- **`browser_get_text` with a selector that matches nothing now fails**
  (`action-failed`) instead of returning successful-looking text
  `No element matched selector: …`, matching `browser_click`.
- **`browser_describe_image` explains which switch is off.** When the local tier is off but
  the desktop app advertised `imageRecognition: true` in `hello.ok`, the error now says the
  extension setting is off and that the desktop app is ready.

### Fixed (field report, 2026-11-08)

- **An unpacked extension is no longer reported as “not installed”.** The install scan now
  also reads each profile's `Secure Preferences` / `Preferences` (`extensions.settings`),
  where a “Load unpacked” install is the only record it leaves, instead of checking just
  `<profile>\Extensions\<id>\`. The “not found” message no longer claims a single install is
  required: it says no install *record* was found, and that both store and unpacked installs
  persist across restarts (only a command-line load does not).
- **The panel's disconnected message points at something that exists.** It no longer says
  “check the bridge address and token in Settings” — the settings sheet has neither input:
  both are discovered from the desktop app. The rejection notice stopped pointing at a
  non-existent “extension token setting” for the same reason.

### Changed (distribution): the built `lib/` is self-contained

`packages/bridge/tsdown.config.ts` now bundles every runtime import —
`@deepseek-ai/schemastery`, `ws`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-llm`,
`@deepseek-ai/dsh-tools` and the helpers those reach — so `lib/index.js` imports nothing
but `node:*`. A `link:` install therefore no longer needs the checkout's `node_modules` to
load, and a packed `.tgz` needs no dependency resolution by the profile either. The bundle
grows from 193 kB to 646 kB (gzip 182 kB); `invariant.js` stays about 1 kB.

Bundling is safe for the host because none of the inlined code carries runtime identity:
cordis validates the plugin `Config` through `Config['~standard'].validate` (duck-typed,
not `instanceof`), `createUserMessage` is `createMessage` + `structuredClone` +
`deepFreeze`, `defineTool` only turns schema specs into JSON Schema and returns a plain
descriptor, and `dsh-brand` documents itself as duplicate-install-safe.

`packages/bridge/THIRD-PARTY-NOTICES.md` records the 14 inlined packages (all MIT) and
ships inside `pnpm pack`; `.github/workflows/check.yml` runs `check-bundle` and
`smoke-bundle` after building, so "no `node_modules` needed" and "the plugin still applies"
cannot regress silently.

### Chrome Web Store extension

Both extension identities are in the default trust list, so a user who installs the
packaged `0.38.7` build from the store (id `agpipnjijkpomaannkijkilggoffdiaf`) and a
developer who loads the unpacked `0.38.8` build (id `kdhkdgfcinfkmogifamoapmheihhcjfk`)
get the same token-free loopback handshake, the same discovery (`/ext/bridge-config` on
`3080, 3081, 3090, 14389, 43189, 19387`) and the same profile-directory detection.
`extensionId` still accepts a comma-separated list for custom builds.

### Version

The root package, `@dsh-browser/protocol`, `dsh-browser-crossplatform`,
`dsh-browser-extension` and both extension manifests all report `0.38.8`. There is no
wire-format change: a `0.38.7` bridge and a `0.38.8` extension interoperate, and so does
the reverse.

### Verification

- `packages/bridge`: **274 passed** (+1 skipped) across 19 files, `pnpm run typecheck`
  clean, `pnpm run build` OK (`lib/index.js` 646 kB + `invariant.js` 1.1 kB). New suites
  cover the unary-Peer threading, the three host eras, the store-ID handshake, a 200-call
  burst, a 1 MB payload relay and the per-Session snapshot queue.
- Live stress against a real `0.2.2-rc.1` Host (`scripts/stress-bridge.mjs`,
  store-extension Origin, no token): 4 000 concurrent `session.models` → 4 000 ok,
  p50 65 ms / p95 72 ms / p99 73 ms in 1.44 s; 20 `workspace.list` p50 5 ms; 10 reconnects
  p50 33 ms; replacement semantics unchanged (4/5 sockets closed with `4000`); host RSS
  +7 MB.
- `pnpm run check-bundle` imports both entries from a directory whose parents have no
  `node_modules` and asserts every specifier is `node:*`; `pnpm run smoke-bundle` applies
  the bundle against the unit-test stub context (1 upgrade route, 17 tools registered).
- `pnpm pack` → `dsh-browser-crossplatform-0.38.8.tgz`, 280 kB, `lib` + `src` +
  declarations + notices, no `node_modules`; extracted into an empty directory both entries
  import.
- `extension`: **54 files, 577 passed** (~14 s), `pnpm run typecheck` clean, `pnpm run
  build` OK (`dist/control/assets/index.js` 131.3 kB).

### Documentation

- `docs/INSTALL.md` / `docs/INSTALL.zh.md` step 2b: the built `lib/` is self-contained —
  `pnpm install` + `pnpm run build` are for *building* only, and a `link:` install needs no
  dependency completion afterwards. The old `ERR_MODULE_NOT_FOUND … '@deepseek-ai/cosmokit'`
  failure now means an outdated/unbuilt `lib/` → rebuild it.
- `docs/BUGS.md` describes only this tree's issues (BUG-008 … BUG-011).
- `skills/dsh-browser-crossplatform-troubleshooting/SKILL.md` gained a version pre-check
  with a symptom → fixed-in table and the two-version build descriptions.

## [0.38.7]

A bridge-only release that fixes the one failure every fresh install eventually hit: the
extension could not stay connected to the desktop bridge.

Two independent defects were stacked on top of each other. First, the bridge mounted its
discovery endpoint only on the host's own web port, which dsh chooses at random on every
start (`19387`, `57342`, `60400`, `63571`, `50966` have all been observed on one machine);
the extension can only probe a fixed list, so it connected only when the random value
happened to be `19387`. Second — and this one kept the panel on 「未连接」 even after the
first was fixed — every authenticated connection died immediately after `hello.ok`, because
the bridge opened the Host's Remote streams without a Peer.

That is the real origin of "installed but nothing connects"; the extension's display name
and its manifest `key` have nothing to do with it, and the id this repository's `key`
produces stays in the allowlist.

### Fixed

- **Remote streams now carry a real Host Peer.** dsh 0.2.x reads `peer.signal` (and
  `peer.principal`) when opening `$events` and `session/follow`. The bridge passed
  `undefined`, so the Host threw `Cannot read properties of undefined (reading 'signal')`,
  the bridge reported `stream-failed`, and the socket closed with `1011` — the extension
  then reconnected in a tight loop while the panel showed 「未连接」. The adapter now takes
  an owner Peer from `connection.createPeer` (falling back to the shared `browserPeer` on
  hosts that lack it) and releases only the Peer it created.
- **The bridge now listens on the extension's fixed discovery ports.** It binds the first
  free port from `3080 / 3081 / 3090 / 14389 / 43189 / 19387`, serves the same
  `/ext/bridge-config` document there, and hands `/ext/bridge` upgrades to the same
  `BridgeServer`, so the token and origin checks are not duplicated. If every port is
  taken it logs one warning; the host-port route keeps working. `discoveryListener`
  (default on) and `discoveryPorts` expose the behaviour.
- **One port list, not two.** `@dsh-browser/protocol` now exports `DISCOVERY_PORTS`; the
  bridge and the extension both import it, so the two halves cannot drift apart.
- **Mounting waits for the gateway services instead of failing silently.** When a dsh build
  injects `typertGateway`/`connection` only after plugin load, the bridge now waits for
  them (`ctx.inject`) rather than throwing and leaving the web server without
  `/ext/bridge-config`. A one-shot guard prevents the route from being registered twice if
  a dependency is replaced.
- **Stale docs corrected**: the plugin settings page title is 「dsh 浏览器设置」, and the
  install examples name `0.38.7`.

### Verification

`packages/bridge` 263 passed (+1 skipped), `packages/protocol` 20, `extension` 548, all
three typechecks green; four extension targets and the zips rebuilt. The built
`lib/index.js` was started against port 3080 and served
`{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`, then released the port. The e2e harness now
pins its test extension to its own bridge URL and skips the page server's port when
choosing a discovery port, so a real desktop bridge on `3080` cannot steer the test browser
to the wrong host.

The **wire format is unchanged**: a `0.38.7` bridge and a `0.38.8` extension still
interoperate.
