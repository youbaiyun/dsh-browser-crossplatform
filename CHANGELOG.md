# Changelog

This project is a derivative of  
[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser). Upstream releases  
are listed only where this fork has something to say about them; see  
[COPYRIGHT.md](COPYRIGHT.md) for which files belong to whom.

## [0.38.7]

A bridge-only release that fixes the one failure every fresh install eventually hit: the extension
could not stay connected to the desktop bridge.

Two independent defects were stacked on top of each other. First, the bridge mounted its discovery
endpoint only on the host's own web port, which dsh chooses at random on every start (`19387`,
`57342`, `60400`, `63571`, `50966` have all been observed on one machine); the extension can only
probe a fixed list, so it connected only when the random value happened to be `19387`. Second — and
this one kept the panel on 「未连接」 even after the first was fixed — every authenticated
connection died immediately after `hello.ok`, because the bridge opened the Host's Remote streams
without a Peer.

That is the real origin of "installed but nothing connects"; the extension's display name and its
manifest `key` have nothing to do with it, and the id this repository's `key` produces stays in the
allowlist.

### Fixed

- **Remote streams now carry a real Host Peer.** dsh 0.2.x reads `peer.signal` (and
  `peer.principal`) when opening `$events` and `session/follow`. The bridge passed `undefined`, so
  the Host threw `Cannot read properties of undefined (reading 'signal')`, the bridge reported
  `stream-failed`, and the socket closed with `1011` — the extension then reconnected in a tight
  loop while the panel showed 「未连接」. The adapter now takes an owner Peer from
  `connection.createPeer` (falling back to the shared `browserPeer` on hosts that lack it) and
  releases only the Peer it created.
- **The bridge now listens on the extension's fixed discovery ports.** It binds the first free port
  from `3080 / 3081 / 3090 / 14389 / 43189 / 19387`, serves the same `/ext/bridge-config` document
  there, and hands `/ext/bridge` upgrades to the same `BridgeServer`, so the token and origin
  checks are not duplicated. If every port is taken it logs one warning; the host-port route keeps
  working. `discoveryListener` (default on) and `discoveryPorts` expose the behaviour.
- **One port list, not two.** `@dsh-browser/protocol` now exports `DISCOVERY_PORTS`; the bridge and
  the extension both import it, so the two halves cannot drift apart.
- **Mounting waits for the gateway services instead of failing silently.** When a dsh build
  injects `typertGateway`/`connection` only after plugin load, the bridge now waits for them
  (`ctx.inject`) rather than throwing and leaving the web server without `/ext/bridge-config`.
  A one-shot guard prevents the route from being registered twice if a dependency is replaced.
- **Stale docs corrected**: the plugin settings page title is 「dsh 浏览器设置」, and the install
  examples name `0.38.7`.

### Verification

`packages/bridge` 263 passed (+1 skipped), `packages/protocol` 20, `extension` 548, all three
typechecks green; four extension targets and the zips rebuilt. The built `lib/index.js` was started
against port 3080 and served `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`, then released the port.
The e2e harness now pins its test extension to its own bridge URL and skips the page server's port
when choosing a discovery port, so a real desktop bridge on `3080` cannot steer the test browser to
the wrong host.

The **wire format is unchanged**: a `0.38.6` bridge and a `0.38.7` extension still interoperate.

## [0.38.6]

A release in two halves. First, six defects that each pointed the model or the reader away from what  
was actually happening: a dispatch a page navigation interrupted was reported as unrecoverable, a  
dispatch that was never answered had no ceiling at all, the text the reader had just sent stayed in  
the composer, the bridge's own "is the extension installed?" diagnosis could not see a Chrome Web  
Store install, an Edge default browser was sent to `chrome://extensions/`, and the panel's first  
settings row reported a desktop permission as if it were the connection status. Second, a pass over  
the panel's settings surface and the extension's own name, which removed two settings values that  
could not do what their labels promised.

The **wire format** is unchanged, so a `0.38.5` bridge and a `0.38.6` extension still interoperate  
exactly as before. The **extension's own settings surface does change** — `sharePageContent` loses  
`'off'`, `sessionScope` loses `'pinned'`, and `pinnedSessionId` is removed — and both retired values  
migrate on load, so an existing profile keeps working. *Changed* below states what each removal  
costs.

### Changed

- **The bridge now accepts any dsh desktop `0.2.x` instead of one exact release.** Every
  `@deepseek-ai/dsh-*` entry in `peerDependencies` was pinned to exactly `0.2.0-rc.2`, so installing
  on a machine running a different 0.2.x — `0.2.1-rc.2` is the current desktop release — produced
  peer-conflict noise and, with `strict-peer-dependencies` on, a failed `dsh plugin add`. Two things
  changed. The ranges are now `>=0.2.0-rc.2 <0.3.0`, and — this is the part that matters — every dsh
  peer is marked **optional**, because dsh is the host that provides these packages at runtime. The
  ranges alone would not have fixed it: semver's prerelease rule excludes `0.2.1-rc.2` from every
  `0.2.x` range, `*` and `0.2.x` included, which is exactly why the pin had to go. The real gate was
  never the version string — the bridge checks for the `gateway.wireStream` capability at mount time
  and names what is missing. `tests/index.spec.ts` asserts the peers stay optional and unpinned, so
  re-pinning one package fails the suite.
- **A missing agent registry degrades instead of failing the plugin.** `ctx.agents` was read
  unconditionally, so a dsh build that does not expose it would break mounting — for a feature
  (injecting browser snapshots back into the session) that is a convenience, not the product. It is
  now optional: the plugin mounts, logs one warning naming the consequence, and snapshot injection
  becomes a no-op. Services that genuinely are required (`webServer`, `tools`, `typertGateway`,
  `connection`) still fail loudly and by name.
- **The extension is now 「dsh 浏览器扩展（全平台）」 / 「dsh 瀏覽器擴充功能（全平台）」 /  
  `DSH Browser Extension (All Platforms)`.** The old 「全端」 read as "desktop plus web plus mobile",  
  which is the one thing this does not support. The **id does not change** — it derives from the  
  manifest `key`, not the name — so the bridge's extension-id whitelist, existing grants and stored  
  settings are untouched. Store listing, both READMEs and the install guides follow.
- **The settings sheet was relabelled row by row, and its first row was answering the wrong  
  question.** That row said 「桌面端允许 AI 打开网页」 but its badge read 已连接/未连接, and it  
  derived "connected" from `policy !== null` — which asks "did the host send a policy", not "is the  
  extension connected". A dropped socket with a policy still in hand displayed as 已连接. It is now  
  「dsh 连接状态」, reads `state.bridge`, distinguishes connecting from stopped, and says what to do  
  when it is not connected. The others: 「AI 读取权限」 (was 「让 AI 读取网页」), 「对话同步」 (was  
  「对话发到」), 「AI 跟随网页」 (was 「AI 跟随标签页」), 「打开浏览器时是否自动打开插件侧边栏」  
  (was 「自动弹出侧边栏」), each with copy that states the behaviour instead of the mechanism.
- **`sharePageContent` no longer has an `'off'` value.** It claimed to keep page content inside the  
  browser, but the shipped-on `unrestrictedBrowserAccess` rewrote the policy to `'auto'` before that  
  value could apply, so on a default install it never took effect: a privacy control promising a  
  guarantee it did not deliver. The two remaining values ask before reading and acting, or ask  
  neither. A stored `'off'` migrates to `'ask'` — the stricter choice — and not to the `'auto'`  
  default, which would have inverted the user's intent. **Consequence worth knowing:** no setting now  
  keeps page text inside the browser. `PRIVACY.md` and the store listing say so.
- **The panel can no longer be pointed at an arbitrary desktop conversation.** `sessionScope` is now  
  `'fresh' | 'last' | 'workspace'` — 「工作区内新建对话」, 「工作区内上次浏览器对话」, 「全部工作区」.  
  The old `'pinned'` mode and its `pinnedSessionId` duplicated "continue the last conversation",  
  which the panel already remembered, so both were removed; a stored `'pinned'` migrates to `'last'`  
  rather than to the default. The conversation `<select>` picker went with them. **This is a  
  deliberate loss of capability, not a bug:** `last` only ever means "the conversation this panel  
  used before".
- **`'workspace'` now mirrors every desktop workspace, not only the browser one.** It used to select  
  the single group whose `path` matched the `sessionWorkspacePath` reported in the handshake, so work  
  driven from any other workspace never appeared in the panel. Every group is mirrored now, still  
  narrowed to conversations that are running or changed within five minutes, which is what keeps the  
  per-conversation follower streams bounded.
- **The empty state no longer says 「准备就绪」 / "Ready".** A blank panel is blank; the title told the  
  reader nothing it could act on. The auto-open row also lost its help paragraph rather than keeping  
  an empty line where the text used to be.
- **The bundled troubleshooting skill now opens with what it covers**, with a symptom → section  
  table (it previously assumed the reader already knew), and its claims about the settings surface,  
  the picker and the `openPagesForUser` row were corrected to match this release.

### Fixed

- **A navigation that interrupted an action made a recoverable page look permanently broken.**  
  `contentScriptReceiverMissing` recognized exactly one error string, `Receiving end does not exist`,  
  so every other shape a whole-document navigation produces — the frame is gone, the document was  
  destroyed, the context was invalidated — failed the test and was answered with *"The content  
  script stopped responding after the operation was dispatched"*. The inject-and-retry recovery  
  immediately below that check exists for precisely this situation, and was skipped. The predicate  
  now recognizes the "the other end is not there" family, and matches the frame message with its  
  number rather than the bare phrase `was removed`: a loose substring also swallows unrelated page  
  failures, and every match authorizes both a re-dispatch and a rollback of a state-changing action.  
  It still deliberately does **not** match a message port that closed *after* an action was  
  dispatched: from the sender that looks identical, but it is not the same event — the page may have  
  run the action and lost only the reply — and re-dispatching a `browser_click` on that evidence  
  would perform it twice.
- **A dispatch that was never answered had no ceiling.** `sendAction` was a bare  
  `chrome.tabs.sendMessage`. `navigation.ts` bounds its own rendezvous and this path had nothing, so  
  a frame whose context was being torn down could leave a tool call pending forever — the one  
  failure a model cannot react to. Dispatch is now bounded, and the bound follows the work: ten  
  seconds for a single action, thirty for `browser_snapshot` and `browser_get_text`, which serialize  
  the live DOM and are legitimately slow on a heavy page. A single ten-second ceiling cancelled that  
  work mid-flight and reported it as an unresponsive script, turning "this page is big" into "this  
  page is broken". Neither path is ever retried: a timeout cannot tell "the page never ran it" from  
  "the page ran it and the reply was lost".
- **Two ways out of the image path escaped as a raw rejection.** When resolving an image required  
  re-injecting the content script, a refused injection or a failed second dispatch propagated out of  
  `requestImageTarget`, and the caller reports a raw rejection as `internal` — a code that names no  
  page-level cause and suggests no next step, for the same page a plain `browser_snapshot` describes  
  as `content-unavailable`. Both are now answered as `content-unavailable`.
- **The text the reader had just sent stayed in the composer.** `submit()` clears `this.draft` in a  
  promise and then repaints the turn in place — header, transcript and send button — to avoid  
  destroying the textarea the reader is typing in. The textarea is therefore the one node that  
  repaint does not rebuild, and nothing wrote the cleared draft back to it, so the sent sentence sat  
  there looking unsent and pressing Enter again sent it a second time. The value is now re-synced on  
  every turn repaint, and only when it actually differs, so a no-op repaint cannot disturb a caret  
  that has already moved on to the next message.
- **The bridge could not see a Chrome Web Store install.** The install check looked for  
  `<profile>/Extensions/<id>` using an id list that held only the development id, so a store install  
  — which lives under the id the store assigned,  
  `…\Extensions\agpipnjijkpomaannkijkilggoffdiaf\…` — was never found, and the failure text then  
  asserted the extension was not installed on the machine at all.
- **Profile enumeration stopped at `Profile 3`**, so `Profile 4` and any custom profile directory  
  name were invisible to that same check. Profile directories are now enumerated from the user-data  
  root, keeping only the real `Default` / `Profile <n>` shapes so `Local State` (a file) is never  
  probed, and falling back to the known names when the directory cannot be listed — an unreadable  
  directory must not become "nothing found".
- **The browser named in the failure was whichever happened to be running first**, not the default  
  one. A reader whose default browser was Chrome, with Edge also running, was told to look in  
  `edge://extensions/`, where the extension was not installed. The default browser now wins when it  
  is among the running processes, then the detection order, and an ambiguous executable name — the  
  one Chrome and Chromium share — resolves to nothing rather than to a guess.
- **An Edge default browser was sent to `chrome://extensions/`.** The candidate resolved from the OS  
  default browser carries the placeholder id `default`, because the OS reports a path rather than a  
  name, and `extensionsPageUrl` recognizes `edge` and falls through to Chrome's scheme for  
  everything else. Every message now resolves the executable back to a detected id before naming a  
  page.
- **The not-found text claimed more than the check had done.** *"The extension is not installed in  
  any browser profile on this machine"* described a search of one id across four profile names. Both  
  messages now name the browsers and profiles actually read, and offer the store route alongside  
  "Load unpacked" instead of only the developer route.

### Added

- Regression tests that fail without the above: an action whose frame is killed by a navigation must  
  recover in place rather than report an unrecoverable error; a frame the page does not have must  
  still be refused without injecting; an unrelated `was removed` failure must not be mistaken for a  
  dead frame; a dispatch that is never answered must settle within its ceiling and must not be  
  dispatched twice, while a slow snapshot must not be cut short; a failed image-path recovery must  
  answer `content-unavailable`; sending a message must leave the composer empty; a store-id install  
  and a `Profile 4` install must both be detected; and the browser named in the message must be the  
  default one.
- The store listing now holds a block per locale, and `tests/locales.spec.ts` asserts each locale's  
  short description against its own block. It previously read the *first* block in the file — the  
  Chinese one, since that is the store's primary locale — and compared it against the English  
  locale, so the drift it was written to catch could never have failed the suite.


## [0.38.5]

The panel's layout, its streaming path, and its interactivity under load. No wire-format or  
settings change: a `0.38.4` bridge and a `0.38.5` extension interoperate exactly as before.

### Fixed

- **The side panel could open blank while its header and composer drew normally.** `.app` and  
  `.sheet` are CSS grids that pinned their *row* axis with a deliberate `minmax(0, 1fr)` guard  
  and never pinned their *column* axis. With no `grid-template-columns`, the implicit `auto`  
  column is sized to its items' max-content, so a single long unbreakable tool summary — a URL,  
  or a run of text with no spaces, exactly what a failed `browser_navigate` produces — stretched  
  the column to ~2346px inside a 360px panel. `body { overflow-x: hidden }` then clipped the  
  content off the right edge. Both grids now declare `grid-template-columns: minmax(0, 1fr)`.
- **The reading cap was written through instead of clamped.** `--panel-max` comes from  
  `settings.readWidth` (default 640), and it was applied verbatim, so a 360px panel laid every  
  text column out 640px wide inside a 360px box — a second, independent way to produce the  
  blank panel above. It is now clamped to the panel's own width, applied *before* the first  
  paint rather than only when the first state push arrived (a panel that never received one kept  
  the stylesheet default of 640), and re-applied by a `ResizeObserver` when the panel is dragged.
- **A long reply could freeze the panel, because the streaming fast path was never reached.**  
  The worker creates a durable `assistant` row on the first delta and keeps it `running`, and  
  that row arrives in `state.timeline`; the panel only treated its own synthetic row as  
  streaming, so `.msg--streaming` never existed, every repaint fell back to a full transcript  
  rebuild, and the partial reply was rendered as finished Markdown on every frame — the  
  quadratic path the streaming mode exists to avoid. A `running` assistant row is now the  
  streaming target, and the repaint updates that bubble in place.
- **Streaming rendered Markdown per frame.** While `streaming` is true the reply is plain text  
  again, which is what the README always claimed; Markdown is rendered once, when the turn ends.  
  Repaints are coalesced to one per animation frame.
- **Every state push destroyed the composer, so typing during a reply was lost.** `turn/start`,  
  `turn/end` and each `state` push called the full `render()`, which replaced the textarea and  
  dropped focus. A 100-round simulation measured 240 lost focus events and 240 swallowed  
  keystrokes in 20 rounds; it now measures zero in 100. Turn boundaries repaint the header,  
  transcript, send/stop button and meta line; state pushes also refresh the settings sheet in  
  place, so its badge updates without rebuilding it.
- **Sending a prompt or stopping a run also destroyed the composer.** The four paths the reader  
  drives themselves — `runPrompt`, `runCommand`, `runOpen` and `stopRun` — still called the full  
  `render()`. Pressing Enter removed the box the draft was in, and the *next* message was  
  discarded when the worker answered. They repaint in place now.
- **The send button could stay a stop button after the turn ended.** The turn flag arrives in  
  `state` as well as in `session.event`, and only the event path refreshed the button. A state  
  push now refreshes it too, which also clears a stale "not connected" line from the meta row  
  once the bridge is back.
- **The conversation picker could latch on 「正在读取…」 because its change check ignored the  
  list.** `refreshSettingsSheet`  
  skips work when nothing it draws has changed, and its change check omitted the fetched  
  conversation list — so the reply to `session.list` was swallowed, the options were never  
  inserted, and a `<select>` holding only its placeholder never fires `change`. The check now  
  covers the list, its loading flag and the pinned id.
- **Switching conversation painted the previous one's half-written reply into the new one.**  
  The in-flight reply text was never cleared when `state.session.id` changed, so the abandoned  
  answer kept rendering — with a blinking caret — inside the conversation just opened.
- **A full repaint always scrolled to the bottom.** `pinnedScroll` was initialised to `true`,  
  read once, and never set back — a constant dressed as state — so all twenty-odd `render()`  
  call sites yanked a reader who had scrolled up. The position is now captured before the rebuild  
  and restored after.
- **The same picker could also latch on "loading" forever when the request never settled.**  
  `requestSessions()` set  
  `sessionsLoading` before the call and its `catch` did nothing, so a dead port left the guard  
  blocking every retry for the life of the panel. `call()` also had no timeout and `dispose()`  
  never settled in-flight requests, so a lost answer meant a promise that never resolved — and a  
  send button that stayed disabled.
- **A rebuilt transcript re-parsed Markdown for every reply on screen.** Rendering is pure, so  
  results are cached. The cache is bounded at the timeline's own size (200 entries) and evicts  
  least-recently-used, because a smaller cache misses for half of a long conversation and an  
  insertion-ordered one lets the replies on screen age out first.
- **Light-mode contrast.** `--text-tertiary` measured 3.71:1 on white and 3.48:1 on `--bg-subtle`  
  while being used as text at 11-13px in a dozen places; it is now 4.93:1.
- **The conversation picker could not shrink**, so a long desktop conversation title pushed the  
  control past the panel edge where `overflow-x: hidden` clipped it — a dropdown whose arrow was  
  unreachable. `prefers-reduced-motion` also left the caret blinking, because shortening an  
  animation's duration does not stop an `infinite` one.
- **The settings button could be clipped away in a narrow panel.** The header's action row was  
  `flex: none` and its buttons do not wrap, so with a lost tab binding the row grew past the  
  panel and `overflow-x: hidden` removed its rightmost control — the panel's only route to its  
  own settings. The row shrinks and its text buttons ellipsise.
- **The half-written-directive hint had no style at all**, so it rendered in the body text colour  
  and read as a statement rather than a reminder.

### Changed

- Streaming updates from the worker to the panel are coalesced to at most one per 50 ms. Each one  
  clones the assistant's whole text and posts it across the port, so notifying per delta was both  
  wasteful and quadratic in the reply length.
- `benchmark/package.json` is now covered by the version-agreement test. It was the one package a  
  version bump could quietly leave behind.

### Added

- A 100-round panel simulation that drives the panel the way the desktop app does — deltas, state  
  pushes, typing, clicks — and reports per-round outcomes, so an intermittent fault cannot pass as  
  a success.
- A nine-step user journey that walks one session end to end and asserts at every step that the  
  content is on screen and the controls still respond. It catches the failures that happen  
  *between* steps, which is where every one of the above was found.
- Regression tests for the grid axes, the reading cap at nine panel widths, the drawing cache, the  
  streaming branch, and the send/stop button.

## [0.38.4]

This release is the 「工作区内」 feature line in full, plus the pass that made it cheap  
enough to ship. `0.38.3` was published before any of it existed, so nothing here changes  
what that version does; it is a new number because the bridge gained a method and the  
extension gained a mode.

### Changed

- **The shipped defaults changed, so a fresh install behaves differently.** Three  
  settings now start where this project's own configuration ended up after living with  
  the extension:
  - `unrestrictedBrowserAccess: true` — a new install answers no approval prompt for the  
    browser tools; clicking, typing and closing tabs proceed. It also overrides  
    `sharePageContent`, forcing it to `auto` at the point the dispatch mode is resolved,  
    so it takes precedence over a user who chose to be asked before a page is read. The  
    strip spells the trade out and turns it off, and the switch is per-record, so a user  
    who turns it off keeps it off.
  - `sessionScope: 'workspace'` — the panel mirrors the desktop's browser workspace  
    instead of starting a conversation of its own.
  - `tabSwitch: 'follow'` — the model follows the tab the user moved to rather than  
    interrupting to ask.
  - **Upgrading users are not silently switched.** Their stored record is read before the  
    bridge connects (`settingsReady` gates `startBridge`), so an existing choice — including  
    `unrestrictedBrowserAccess: false` — is what applies. Only a record that says nothing  
    about a field inherits the new default, which is the case for a genuinely fresh  
    install.
  - Normalisation for `unrestrictedBrowserAccess` and `sessionScope` was also wrong in a  
    way that would have hidden this: both fell back to a hard-coded literal rather than to  
    `SETTINGS_DEFAULTS`, so changing the default had no effect on the normalised result.  
    Both now reference the default, and `unrestrictedBrowserAccess` keeps a real `false`  
    instead of collapsing every unreadable value to `false`.

### Added

- **「工作区内」: the panel mirrors a whole workspace, so nothing has to be picked in  
  advance.** The other two modes mirror exactly one conversation, which meant an  
  instruction issued on the desktop was only visible here if that conversation had been  
  chosen beforehand — and choosing it was the hard part, because the desktop publishes  
  no "session I am looking at" signal. The third option reads the desktop's browser  
  workspace and follows *every* conversation in it, so work started on the desktop side  
  appears on its own.
  - The group is identified by the **path** the bridge names in the handshake  
    (`policy.sessionWorkspacePath`), not by its title: a user may rename 「浏览器对话」,  
    and a path is what the desktop keeps stable. Absent when the grouping is switched  
    off, which is exactly when the mode has nothing to mirror.
  - A follower is opened per conversation, because the bridge streams nothing until  
    someone asks and the panel never prompts most of them.
  - Timeline rows carry the conversation they came from, so several mirrored transcripts  
    do not interleave into one unreadable column. Leaving the mode, or a conversation  
    leaving the group, drops only the affected rows.
  - Prompts still go to the panel's own conversation. Mirroring is about watching what  
    the desktop drives; writing into a mirrored conversation is a different feature and  
    is deliberately not part of this.
  - **In its steady state it follows only the conversations that are actually live.**  
    Following every member of a workspace costs one server-side stream per member to  
    watch the one or two producing something, and a group grows as conversations  
    accumulate. There is no poll-free signal to use instead — `workspace/follow` pushes  
    only its baseline and a workspace's own `updatedAt` moves on membership rather than  
    activity — so the mode reads cheap metadata: `updatedAt` moves when a conversation  
    produces an event and stays put when it does not, and `running` marks a turn in  
    flight. A conversation that starts working is followed on the next tick; one that  
    goes quiet is dropped. A turn in flight is kept however long ago it last emitted, so  
    a slow turn is not dropped halfway through. Entering the mode still mirrors the whole  
    group once, which is what brings an existing transcript on screen.
- **The bridge can follow several Sessions at once**, which the mode above needs. It  
  kept a single follower per connection and opening a new one aborted the previous, so  
  asking for nineteen conversations left exactly one streaming while the panel looked  
  like it was working. Followers are now keyed by Session, each with its own abort  
  controller and its own notion of being current; the shared generation counter that  
  decided "am I still wanted?" is gone too, because a counter shared by the whole  
  connection made every *other* Session look replaced the moment a new one was followed  
  — the same failure reached a different way. Re-asking for a Session already followed  
  is a no-op, which matters because the extension asks on every refresh tick.
- **`session.unfollow`, so streams are released when the mirror shrinks.** It takes the  
  set still being watched rather than the set to close: the extension's mirror is the  
  authority, so a bridge that missed an earlier change still converges on exactly the  
  streams wanted, and naming a conversation that is not followed is a no-op. Without it,  
  leaving the mode left the bridge reading every conversation it had ever opened until  
  the connection ended. The extension posts it best-effort and swallows a failure, since  
  the two halves upgrade separately — an older bridge answers with an error and the only  
  consequence is that streams are held a little longer.
- **A Chrome Web Store install connects with no configuration.** `extensionId` now takes  
  a comma-separated list of ids (`DEFAULT_EXTENSION_IDS`), defaulting to this  
  repository's development id and `agipnijjkpomaannkjkjliggoffdiaf`, the id the Chrome  
  Web Store assigned. One build genuinely has two possible ids, because the store  
  refuses a manifest carrying `key` and then assigns its own. Matching stays exact per  
  entry — an unlisted id, a *prefix* of a listed one, another scheme, and an empty  
  configuration are all refused.


### Fixed

- **`browser_launch` claimed a windowless browser was running.** A Chromium process  
  outlives its last window and the extension keeps its socket open while it does, so  
  "a connection exists" said nothing about whether there was a page to act on. The tool  
  answered "already running and connected" to someone looking at no browser at all, and  
  every page tool then failed with "no active tab". `launchBrowser` had the same blind  
  spot in its own early return. The bridge now asks the window manager (PowerShell  
  `MainWindowHandle` on Windows, System Events on macOS) how many windows the running  
  browsers own, and acts only on a **definite** "none": an unsupported platform, a shell  
  that will not run, and a probe that throws all degrade to "unknown", because a wrong  
  `false` opens a browser window nobody asked for.
- **A prompt could be delivered to the conversation the user had just left.** Creating or  
  restoring a conversation is a round trip, and picking another one during it correctly  
  stopped the *adoption* — but the resolved id was still handed to `sessionRpc.prompt`.  
  The binding is now re-checked after the await and the send is refused with a sentence  
  that says to send it again.
- **A refused `browser_type` wrote the typed value into the activity list.** The refusal  
  quotes the value it could not match, which put a password or a token into  
  `ControlState.activity` and the timeline — the two places `activity.ts` promises never  
  to echo typed text. The reason is kept and the value is replaced by its length.
- **A duplicate `tool.call` id could hang the revocation barrier forever.** A second  
  frame with an id already in the map replaced the entry, and the replaced call's  
  close-out then returned early — so its one-shot `settle()` never fired and  
  `cancelAllToolCalls()` could no longer reach it. `settled` is what  
  `revokeUnrestrictedAccess()` awaits, so "unrestricted access = off" cleared in memory  
  but never reached `storage.local`, and an MV3 restart restored it.
- **A cancelled image-recognition call still uploaded the image.** The relay path sent  
  `image.call` without checking the abort signal first, so a call cancelled while queued  
  behind another image was dispatched anyway — the user's image sent for an answer  
  nobody was waiting for, and billed.
- **A failed `session.follow` was the one failure with no surface.** The panel stayed  
  correctly bound, received nothing, and looked exactly like a conversation with nothing  
  in it — which is what a desktop app running an older bridge produces. The worker now  
  turns that specific failure into a panel notice naming the fix, and clears it once a  
  follow succeeds or the connection changes.
- **The conversation picker was unreadable, and two field bugs caused it.** `listSessions`  
  read `item.title`, which does not exist — the desktop nests it at  
  `projections.values.title` — so every conversation was labelled "Untitled". A fifth of  
  the list was not conversations at all: every delegated sub-agent is a Session of its  
  own, so the picker filled with rows called "You are a senior code reviewer", now  
  filtered on `origin`/`parentSessionId`. And it now shows the opening prompt, which is  
  the fact that actually distinguishes two conversations whose titles collide by design.
- **Two hooks that were written and never called, and were real gaps rather than  
  tidiness.** A relay recognition in flight could not be settled when the socket  
  dropped, so it waited out its full timeout; an approval the user could no longer answer  
  stayed open, because losing the connection closes the control strip and the decision  
  then has nowhere to come from.

## [0.38.3]

No code shipped as this version. It was incremented while the 「工作区内」 work was in  
progress, and that work was released as `0.38.4` instead, so this entry records only why  
the number was taken: **npm retires version numbers two different ways, and this package  
has hit both.**

- `0.38.0` was published and then unpublished. npm permanently retires a version that has  
  been unpublished, so it can never be published again.
- `0.38.1` was accepted by `pnpm publish`, which stages a package and waits to be told to  
  promote it. The promotion never happened, and the registry now refuses to publish over a  
  staged version.
- `0.38.2` was published with `npm publish`, which writes directly and does not stage. It  
  is the version `latest` pointed at until `0.38.4`.

## [0.38.2]

No code changed. Only the version number, for a reason worth writing down: **npm  
retires version numbers two different ways, and this package has now hit both.**

- `0.38.0` was published on 2026-10-06 and unpublished 23 minutes later. npm  
  permanently retires a version that has been unpublished, so it can never be  
  published again.
- `0.38.1` was accepted by `pnpm publish`, which stages a package and waits to be  
  told to promote it. The promotion never happened, and the registry now refuses  
  that version with `409 Cannot publish over previously staged version "0.38.1"` —  
  a marker that survives the staged record being emptied (`pnpm stage list` reports  
  nothing).

`0.38.2` is the first version number on this package name with no history behind  
it. Until now the registry has also been carrying a `0.0.0-stage` placeholder as  
`latest`, which is what a client would have downloaded; a normal publish replaces  
it as `latest`.

Publish with `npm publish`, not `pnpm publish`: npm writes the version directly  
and does not stage it, so there is nothing left to promote.

## [0.38.1]

A naming and wording release. No behaviour changed.

### Changed

- **The extension is called `dsh 浏览器扩展（全端）`** (`dsh 瀏覽器擴充功能（全端）`  
  in Traditional Chinese). The parenthetical said `应用端` — the *application* side —  
  which described only one end of a product that has several. The English name,  
  `dsh Browser Extension`, already carried no such limit and is unchanged.
- **The short description now says which model reads a picture.** The Chinese version  
  ended at "会把你要看的那张图交给桌面端", which reads as though the desktop app looks  
  at the image itself; the picture is handed to the model configured there, so it now  
  says so. The English version was reworded to match (`Image look-up is optional` →  
  `Image look-up optional`) and is **122 characters** against the store's 132 limit —  
  short enough that naming the model there as well would have pushed it over, which is  
  why the detailed description carries that detail instead. The store listing, the  
  paste-in sheet and the submission form were kept byte-equal to `_locales/en`, which  
  `extension/tests/locales.spec.ts` asserts.
- **`0.38.0` was never published to npm and cannot be**: the name  
  `dsh-browser-crossplatform` was registered on 2026-10-06 and unpublished 23 minutes  
  later, and npm permanently retires a version number that has been unpublished. This  
  release therefore takes `0.38.1`, and every version-holding file moved with it.

## [0.38]

A correctness and truthfulness pass over 0.37: one security boundary narrowed,  
a browser that is closed can now be started by the desktop, several claims in the  
documentation brought back in line with the code, and the release tooling made to  
produce what the stores actually accept.

### Added

- **A task list the user can watch.** A request that needs several browser steps was  
  previously visible only as a stream of tool calls: the reader could see each step  
  but not the job they belonged to, and a finished step looked exactly like a  
  pending one — the same request apparently repeating. Now the model opens such a  
  turn by writing the checklist it is about to execute and re-emits it with the  
  boxes ticked as it goes, and the panel renders that checklist above the run with  
  the task in progress, the finished ones and the failed ones marked.
  - The format is a plain markdown checkbox list (`- [ ]`, `- [>]`, `- [x]`, `- [!]`),  
    declared to the model in the bridge's system-prompt section and parsed by  
    `packages/protocol/src/plan.ts`, so the wording the model is given and the shape  
    the panel reads cannot drift.
  - The rule lives inside the prompt's existing ASCII-only section, so the  
    homoglyph assertion in `packages/bridge/tests/index.spec.ts` covers it too.
  - A streaming update never shrinks the list: the model rewrites the checklist  
    while it is still arriving, so the panel keeps the more complete of the two  
    versions (`preferPlan`) instead of truncating the list on every tick.
  - A plan written without boxes is still recognised, but only under a heading that  
    announces one, so an ordinary bulleted answer is not mistaken for a task list.
- **The activity line now carries the outcome, not just the attempt.** Every  
  successful row used to read `browser_navigate https://www.bilibili.com` — what was  
  asked for, with nothing about whether it happened, so a completed step was  
  indistinguishable from one that never ran. Rows now end with the tool's own  
  one-line answer (`✓ Opened a new tab at …`), `browser_list_tabs` reports how many  
  tabs it listed, and the URL in the request part is still reduced to its origin so  
  paths and query terms do not accumulate in the list.
- **`browser_launch`, and a preflight on every browser tool.** Tool execution lives  
  in the extension, so a closed browser left the model with a bare `bridge-closed`  
  error and no way out. A call with no connection now tries to start the browser  
  first and reports what actually happened.
  - It launches **the browser the user already uses** — the executable comes from  
    the system's default-browser record — with **no extra flags at all**: no  
    `--user-data-dir` (that would be a second browser, with none of the user's tabs  
    or logins) and no `--load-extension`.
  - If that browser is **already running, nothing is launched**: a second start only  
    hands the request to the existing process and discards the flags, so the answer  
    names the browser to enable the extension in rather than opening a dead window.
  - It also checks whether the extension is installed in any Chrome/Edge/Brave/  
    Chromium profile and says which situation applies, because a launch cannot  
    install anything: an unpacked `--load-extension` lasts one session and is gone  
    at the next start (verified), and since Chrome 137 branded Chrome/Edge builds  
    ignore the flag entirely (Chromium and Chrome-for-Testing still honour it).
  - Gated by `openPagesForUser`, the switch that already decides whether the model  
    may drive the browser to new places. `browserUserDataDir`, `extensionPath` and  
    `browserHeadless` cover the development case, a named profile that genuinely  
    loads an unpacked build.
  - **The dead end is closed explicitly.** Being told "install the extension" with  
    no destination is what left users stuck, so the answer now carries the browser's  
    own extensions page (`chrome://extensions/` or `edge://extensions/`) and the  
    bridge **opens that page** at the moment it has established the extension is  
    installed nowhere — the only situation with no automatic way out. Opening it  
    goes through the OS handler (`cmd start` / `open` / `xdg-open`), so it lands in  
    whichever browser the user actually uses, Firefox included. `docs/INSTALL.md`  
    and its Chinese twin now lead with "install the extension first, in the browser  
    you actually use" and gained a "the browser was closed and the model could not  
    open it" entry; the troubleshooting skill gained the same two checks.


### Security

- **The token-free loopback path is now bound to one named extension.** It used to  
  accept any upgrade whose `Origin` merely started with `chrome-extension://` —  
  and every other extension installed in the same browser presents one of those,  
  so any of them (or a local process that simply sets the header) could reach the  
  full browser tool surface without the token. The check is now an exact match  
  against the configured `extensionId`, whose default is the id this repository's  
  manifest `key` derives (`kdhkdgfcinfkmogifamoapmheihhcjfk`). Set  
  `extensionId: ''` to require the token on every connection, loopback included.  
  `docs/TRUST-MODEL.md` states the residual exposure plainly: a process that knows  
  the id can still forge the header.

### Fixed

- **Copy that contradicted the code, found in a pre-release pass over every  
  user-facing string.** Each of these made the product describe something other  
  than what it does:
  - The store listing claimed "no dashboards, no progress bars" while the panel now  
    renders the per-turn task list with a `{done}/{total}` counter. Both languages  
    were corrected in `store-assets/store-listing.md` and its paste-in twin.
  - `plan.progress` counted **failed** tasks as completed (`{done}` received  
    `done + failed`), so a 3-pass/2-fail checklist read "5/5 已完成" beside two rows  
    marked `✕`. Only finished tasks count now.
  - The settings row read "AI 能打开网页" / "AI can open web pages" next to a badge  
    that reports the *handshake*, which could read as "this feature is off" — in a  
    store review, as a permission the extension does not have. The label now names  
    the desktop as the side that decides.
  - `visionTierHelp` (EN) promised "every image looked at is one request", which the  
    24-hour description memo and per-identity de-duplication contradict; both  
    languages now state the cost, what leaves the machine, and that a repeat  
    question is answered from the memo.
  - Five copy keys that nothing rendered were removed from both languages  
    (`common.working`, `composer.commandBadge`, `composer.askBadge`,  
    `composer.unavailable`, `approval.origins`).
  - `store-assets/permission-and-data-disclosure.md` now says what the relay sends  
    when the extension's own image fetch fails: the image's address, not its bytes.
- **The end-to-end suite was passing without running.** It drove the system  
  Chrome, which since 137 ignores `--load-extension`, and a missing browser made  
  the suite *skip* — a green that proved nothing. CI now installs Playwright's own  
  Chromium (via `benchmark/lib/browser-install.mjs`, which resolves the CLI  
  through Node instead of a shell) and the resolver  
  `benchmark/lib/chromium-path.mjs` asks `playwright-core` which revision to load,  
  so the path cannot drift. The e2e also binds whichever discovery port is free  
  rather than 3080 specifically, because a leftover socket used to surface as a  
  60-second "no connection" failure that said nothing about the cause.
- **`Compress-Archive` was wrong for a store upload.** It writes `\` entry names,  
  which the stores reject, and the publishing notes only warned about Windows  
  "send to → compressed folder". Both archives are now produced by  
  `extension/scripts/package.mjs`: a dependency-free ZIP writer that always emits  
  `/`, refuses a backslash entry, and names each archive after the version in the  
  manifest inside it.
- **`extension/scripts/build.mjs` no longer passes `shell: true` with an argument  
  list** (Node 24 deprecates it, DEP0190); the Windows `.cmd` shim is named  
  explicitly instead, so watch and build behave the same on every platform.
- **`README.md` and its Chinese twin described a design the code does not have.**  
  The manifests still declare global `content_scripts` (the README claimed they  
  were removed), the tool surface is 17 including `browser_launch` and  
  `browser_describe_image` (said 15), the image section shares the interactive item  
  budget rather than splitting the character budget, the vision default is  
  `deepseek-flash` (one example showed `deepseek-v4.1-flash`, the display name the  
  code says returns 400), and a dozen file paths pointed at modules that do not  
  exist in this tree.
- **Two capabilities the tool schema promised were implemented rather than  
  retracted.** `browser_type` advertised filling a `<select>` and setting a  
  checkbox/radio, and `browser_wait` advertised `selector`/`text` conditions that  
  fail with `timeout` — the executor did neither: a `<select>` was rejected as "not  
  editable", a checkbox was written through the text `.value` path, and a wait  
  condition was silently ignored so the model got a success for something that  
  never happened. Both now work (`content/actions.ts`) and are pinned by  
  `extension/tests/actions-form-controls.spec.ts`. A schema that promises behaviour  
  is a bug report against the executor.
- **The temporary connection trace was removed** (`dshBridgeTraceProbe`). It was  
  marked "Remove before publishing" and still wrote a rolling 120-line log into  
  `chrome.storage.local` on every discovery attempt.
- **Launch resolves the extension directory only if it holds a `manifest.json`.**  
  An unrelated `extension/dist` above an installed package would have been passed  
  to `--load-extension`, and Chrome refuses to start over a bad path.
- **Two prompt constants are now asserted instead of described.** The system-prompt  
  halves are exported (`BROWSER_PROMPT_PREAMBLE` / `BROWSER_PROMPT_MARKER_RULE`)  
  and `packages/bridge/tests/index.spec.ts` fails if either grows a non-ASCII  
  character or starts quoting the panel marker itself — the anti-impersonation  
  invariant that previously rested on a comment.
- **`extension/package.json` declared Node `^22.19 || >=24`** while the root, the  
  bridge and the README said `>=20`; they agree now (the protocol package declares  
  no `engines`, being a private workspace package with no scripts to run).

### Changed

- **Version 0.38.0 across the tree**, asserted by `extension/tests/versions.spec.ts`  
  so the four copies cannot drift again.
- **The workspace gained `benchmark/` as a member**, so its one devDependency  
  (`playwright-core`, used to run the baseline browser and now the e2e's Chromium)  
  installs with the same `pnpm install` as everything else. `check.yml` also runs  
  the benchmark's own unit tests and the packaging step, and no longer points the  
  e2e at `/usr/bin/google-chrome`.
- **`config/` is now a sanitized template.** The three desktop-config backups had  
  this machine's absolute paths and its real workspace/session ids in them; they  
  are placeholders now, with the convention documented in  
  `config/README-what-these-are-and-how-to-restore.md`.
- **The packaged signing key and both committed archives were removed**  
  (`extension/dist.pem`, `extension/dist.crx`, and the two 0.37.1 zips, which no  
  longer matched the tree). Archives are built on demand, not shipped in the  
  source.
- **The bundled troubleshooting skill was repaired**: its `name` now matches its  
  directory, and its paths point at `packages/bridge` rather than the pre-0.37  
  layout.
- **`browser_launch` validated the page it was told to open.** The value becomes an  
  argument in the browser's argv, so `--headless` or `--load-extension=…` was read by  
  the browser as a switch rather than as a page. Only an absolute `http:`/`https:`  
  address is passed through now (`isWebUrl`/`webUrlOrUndefined`), on both the launch  
  and the argument-building side, and a padded address is trimmed.
- **Turning unrestricted browser control off could fail to persist.** The revocation  
  barrier awaits each in-flight call's `settled` promise, but `cancelAllToolCalls`  
  emptied the map without resolving them, so a disconnect inside the window left the  
  barrier waiting forever and the restrictive setting was never written — the safety  
  switch silently not applying. Cancellation now settles every call, and the  
  in-memory flag is cleared *before* the barrier so a call arriving during it cannot  
  still capture the grant.
- **A superseded `session.create` could resurrect itself.** The fresh-session id was  
  written to storage unconditionally, so a create that lost the race re-bound the  
  panel to a conversation the user had just switched away from; it is now written  
  only while its generation is current.
- **`detach` preserved the wrong rows.** A tool step row carries the id of the  
  activity row it belongs to (`callId`), not its own, so matching on `id` dropped  
  exactly the in-flight rows the parameter existed to keep.
- **`browser_type` reported success for changes that did not happen.** A disabled  
  checkbox/radio accepted no click, and a checked radio cannot be unchecked, yet both  
  answered "Checked/Unchecked". Disabled controls and the radio case are refused, and  
  the state is verified after the click.
- **`browser_wait` text matching and budget.** The needle is whitespace-collapsed like  
  `pageText` (a multi-line label could never match), the budget is clamped  
  (`WAIT_MAX_BUDGET_MS`, since `1e999` parses to Infinity), and the default condition  
  timeout is 10s rather than 15s because a cancelled call cannot interrupt the  
  content-script poll.
- **A cancelled image recognition still hit the network.** `DirectRecognizer` lacked  
  the `signal.aborted` pre-check that `BridgeRecognizer` had, so a request whose  
  caller had already given up was sent anyway.
- **`browser_describe_image` coerced its arguments.** `Number(null)` is 0, so  
  `index: null` described the first image; a bad `frame` silently became frame 0.  
  Both are refused now, like the tool-dispatch path already did.
- **Snapshot baselines were never pruned** when a tab closed — one entry per tab ever  
  snapshotted, for the life of the worker.
- **`pnpm run build` could not work on Node 24 + Windows at all.** `scripts/build.mjs`  
  spawned `vite.cmd`, which returns `EINVAL` without a shell (and `shell: true` with an  
  argument list is deprecated as DEP0190), and a failed spawn reported nothing, so the  
  build exited 1 with no output. Vite is now run through `process.execPath` with its  
  JavaScript entry point, and a failed spawn prints why.

### Known

- The 0.37 note below claimed a test asserted "exactly one WebSocket". That is no  
  longer true: `background-session.spec.ts` asserts `toBeGreaterThan(0)` with the  
  comment "At least one, not exactly one: … a test that counts dials fails for a  
  legitimate retry". The assertion was relaxed, so the flakiness it described is  
  gone and this entry is kept only to correct the record.
- **Nothing restores in-flight state across an MV3 worker restart.** Pending  
  approvals, session grants and snapshot baselines live in memory only, so if the  
  worker is stopped while a tool call waits on an approval (up to 120 s) the call is  
  never answered and its panel card is gone. Conversations are unaffected — they are  
  owned by the desktop side — but the model's call times out rather than resuming.  
  Persisting approvals would mean persisting a decision the user has not made yet,  
  which is worse than the timeout, so this is listed as a boundary rather than a bug.
- `approvalNotifications` remains a stored setting that the notification path  
  bypasses by design (the panel is the notification surface when it is closed), and  
  `visionThinking`/`visionTimeoutMs` exist only in the desktop plugin config, not in  
  the extension's `Settings`. Both are deliberate; they are listed so a reader  
  comparing the settings sheet with the storage schema does not read the difference  
  as drift.


## [0.37]

A rewrite rather than a patch release. The packages were renamed and re-cut, so the
paths in the previous entry no longer describe this tree; both layouts are described
in the README.

### Added

- **Images can be read, when the user asks.** The model could describe a page but not
  a picture on it, which is what a product page, a chart or a screenshot of an error
  often is. The desktop now relays the image to the model the user configured, with
  four tiers — off, low, standard, enhanced — and **off by default**: nothing is
  fetched and nothing is sent until the user turns it on, and the panel's help text
  says why the recommendation is to leave it off, including what a look costs.
- **A benchmark that measures instead of describing.** Six tasks covering the shapes a
  browser agent meets (read, single action, form, search, multi-step, dynamic), run
  against a fixture site with seeded variation, comparing this extension with the
  runner's Playwright baseline on the same model and machine: success rate, completion
  time, tool calls and prompt tokens per task. Speed claims about a browser backend are
  only meaningful as a paired comparison, because the model dominates absolute time.
- **Continuous integration**, on the same steps a release uses: a frozen-lockfile
  install, a forced typecheck, the tests, and both extension targets. The build runs
  before the tests so that the two checks which skip without a build actually run.

### Changed

- **The layout.** `packages/browser/bridge-browser/` became `packages/bridge/`,
  `extensions/dsh-browser/` became `extension/`, and the wire contract moved into its
  own package, `packages/protocol/`.
- **The extension's network policy.** Its content security policy allowed loopback
  only, which meant the worker's own image fetch could never reach a real host: the
  desktop had to fetch instead, and the desktop cannot carry the user's cookies, so an
  image behind a login was unreadable. `connect-src` now also allows `https:` and
  `http:` for that one operation, and the store's permission justification says so,
  because a reviewer reads it next to the manifest.
- **One version across the tree.** The root, the protocol, the bridge and the extension
  all carry 0.37, so a plugin list, a manifest and a tag cannot disagree.

### Fixed

- **A store-listing assertion had been skipping itself.** It resolves the repository
  root two levels up; the path arithmetic taken from upstream was three, so it pointed
  above the repository and the check that the listing and `_locales/en` agree had
  never run. It runs, and it passes.
- **Asking about an image twice downloaded it twice.** The bytes were fetched before
  the cache was consulted — invisible while the policy refused every real host, and a
  real download per repeat once it did not.
- **`cancelPendingWork()` cleared a timer but not the dialing.** A client that was
  reconnecting opened a socket after the teardown meant to end it, and a `startBridge`
  already in flight created a fresh client. Cancellation now abandons that start and
  stops the client.

### Known

- One test in `background-session.spec.ts` was described here as asserting that
  exactly one WebSocket was opened, with the worker free to dial twice under load.
  The assertion was subsequently relaxed to "at least one" — see the 0.38 entry,
  which corrects this note. The dead `approvalNotifications` setting and the
  desktop-only `visionThinking`/`visionTimeoutMs` keys are likewise covered by the
  0.38 entry rather than repeated here.
