# Trust model

What this extension can reach, what it stores, and what decides whether it acts.
Written so that a person who does not want to read the source can still decide
whether to install it, and so that a reviewer can check each claim against a
named file.

Everything here was verified by reading the code and running the test suite at
the release named in [CHANGELOG.md](../CHANGELOG.md). Where a claim is a limitation
rather than a guarantee, it says so.

## The one-line version

The extension talks to exactly one thing — a bridge on your own machine — and a
page never gets to decide what it does. Everything below is the detail behind
that sentence.

## Network: where data can go

There are five outbound calls in the whole extension. All five are in
`extension/src/`:

| Where | What it is | Destination |
|---|---|---|
| `background/bridge.ts` | the control channel to the desktop app | `ws://127.0.0.1:<port>/ext/bridge` |
| `background/index.ts` | probing whether a bridge is listening | `http://127.0.0.1:<port>/ext/bridge-config` |
| `background/index.ts` | the same probe, per candidate port | loopback |
| `background/image-fetch.ts` | the image you asked about, when image recognition is on | that image's own address, over `https:` or `http:` |
| `background/vision.ts` | recognising an image **directly**, when this deployment configured an endpoint | that endpoint, over `https:` or `http:`, with the configured key |

There is **no analytics, no telemetry, no crash reporting and no update check**.
Nothing about your browsing is sent anywhere except your own machine — with two
exceptions, both belonging to image recognition, which is off by default: the worker
fetches the image you asked about (carrying your cookies) and hands the bytes to the
desktop app, and — only if this deployment set `visionEndpoint`/`visionApiKey` in
extension storage — it may instead POST that image to the configured endpoint itself.
Recognition is off until you turn it on. This is the claim to check first if you are
deciding whether to trust the extension, and it is checkable in one search:

```bash
grep -rnE "fetch|WebSocket|sendBeacon|XMLHttpRequest|EventSource" extension/src
```

That search finds the literal calls. Two of them are deliberately indirect —
`image-fetch.ts` calls an injected `fetchImpl`, and `vision.ts` does the same — so
read those two files rather than trusting the hit count alone. Upstream's
`raw.githubusercontent.com` entry is gone and nothing replaced it.

### What that search does not cover, stated plainly

The bridge **address is a stored setting** (`bridgeUrl`), and the background reads
it if it is set. The panel deliberately does not expose the field — the settings
sheet offers only choices the Chrome-over-loopback path lets a user make — so
changing it requires editing the extension's own storage. But the capability
exists, inherited from upstream: a `bridgeUrl` pointing at a remote host would
send page text, tool calls and replies there.

That is the single largest thing this extension could be made to do that a user
would not expect. It is not reachable through the interface, and it is why this
document exists rather than a shorter one. If you want the strongest setting,
leave `bridgeUrl` empty and let discovery find the local bridge.

## Host access: which sites

`host_permissions` is `http://*/*` and `https://*/*`, and a content script
declares the same match set. In practice that means:

- **The content script is injected broadly**, because the extension cannot know in
  advance which tab you will point it at.
- **It is bounded at the other end.** Which tab is actually read and operated is
  chosen by you — the panel binds one tab, and the trust model refuses an action
  on any other. Broad injection, narrow authority.
- **Nothing runs until something asks.** Content scripts only take part in a
  snapshot or an action. There is no timer, and no background reader.
- **`chrome://`, `file://`, and other browser-internal pages are out of reach**,
  by browser policy rather than by choice here. `activeTab` was declared and never
  used, and was removed; the broad host permission is what actually grants access.

## Stored data: what stays on your machine

Kept in `chrome.storage.local`, which is per-profile and never synced:

| Key | What it holds |
|---|---|
| `dshSettings` | all your choices in one object: the bridge address and token, panel behaviour, tab-switch mode, page-sharing mode, and — if this deployment configured direct recognition — the endpoint, model and key. Note that page-sharing mode is **not in force while unrestricted access is on**: it is overridden to `auto` when a tool is dispatched, so a reader debugging "it read the page without asking" should look at the unrestricted switch, not at this field |
| `dshFreshSessionId` | which conversation the panel is bound to, so it survives the worker being recycled |
| `dshImageCache` | the description produced for each image you asked about, keyed by image address, so asking twice does not fetch or describe it twice. Bounded to the 200 most recent and expired after **24 hours**, because the worker can be stopped and restarted at any time and a memory-only memo would be lost |
| `dshOnboardingSeen` | whether the first-run notice has been shown |
| `dshTabAffinity` | which tab is controlled, so a recycled worker comes back to the same one. This one uses `chrome.storage.session` (memory) on purpose: it is meaningless after a browser restart |

The bridge token is a **field of `dshSettings`**, not its own key. It is sent to the
desktop app in the `hello` frame — that is what it is for.

Also local, in the desktop app's own storage rather than the browser's: the
conversations themselves. They live in the dsh workspace at
`~/.dsh/browser-sessions`, grouped under a workspace named 浏览器对话.

**Page text is sent to the desktop app and to the model you configured there.**
That is the feature. It is not sent anywhere else by this extension, and the
desktop side is governed by your dsh configuration, not by this repository.

## What never leaves the page

- **Password and payment-card field values are masked before the snapshot is
  built**, not filtered afterwards. `src/content/privacy.ts` decides: a
  `type="password"` input, an `autocomplete` of `credit-card` or anything starting
  `cc-`, and any field whose id, name or `aria-label` mentions `password`,
  `passwd`, `pwd`, `credit`, `card`, `cvv`, `cvc` or `secret`. A non-empty value
  becomes a fixed placeholder, so the model learns that a value is present
  without learning it.
- **Text typed into a `type` action is not echoed** into the approval prompt. The
  prompt reports the character count and says so explicitly
  (`src/background/authorization.ts`).
- **Files are never uploaded.** There is no `input[type=file]` handling, no
  `FileReader`, and no `DataTransfer` anywhere in the extension — searched, zero
  matches.
- **No screenshots, ever.** The page channel is text by construction, so there is
  no image that could contain a password field.
- **Full URLs are sent to the model**, because it has to know which page it is on;
  a path can carry a session identifier, and that is a deliberate trade rather than
  an oversight. Only the panel's own activity list is reduced to the origin.

If you find a value that should have been masked and was not, that is a security
report — see [SECURITY.md](https://github.com/youbaiyun/dsh-browser-crossplatform/security/advisories)
or open an issue in the project's tracker. There is no `SECURITY.md` in this tree; the
tracker is the reliable route.

## Who decides whether the model may act

Three gates, in order:

1. **You choose the tab.** The extension operates the tab you bound, not whatever
   is in front. What a manual tab switch does is the 「AI 跟随标签页」 setting: the
   shipped default is `follow`, which moves the binding to the tab you went to; `ask`
   stops and asks; `keep` stays where it was. It is never inferred — the mode is read
   from the setting, so the same switch behaves the same way every time.
2. **The site's trust state decides.** Reads and writes are separate kinds. A site
   you have allowed for reads is not thereby allowed for writes.
3. **Approval — when it is on.** Clicking, typing and navigating fail closed: with no
   answer, nothing happens. Approvals appear in the panel, or as a system notification
   when the panel is closed.

**Approval is off in the shipped configuration, and that is the part to read carefully.**
`unrestrictedBrowserAccess` is a **persisted switch**, not a per-connection one: once set
it stays set across reconnects and browser restarts, and it defaults to **on**. So on a
fresh install gate 3 does not run at all — there is no approval card, and nothing fails
closed — and the switch is what a reader should check first when clicks or typing happen
without a prompt. Turning it off restores gate 3, and the choice is preserved per record,
so a user who turns it off keeps it off.

It has a second effect that is easy to miss: while it is on, the tool dispatch mode is
resolved as `sharePageContent: 'auto'`, which **overrides** the panel's 「AI 读取权限」
setting. A user who chooses 「每次询问：AI 读取网页和执行操作时都会询问」 is not asked while
unrestricted access is on. The two settings are not independent, and the panel does not
say so; this document is where that is written down.

Treat leaving it on as a standing decision rather than a one-session one.

## What the model can and cannot influence

- **Page content is untrusted input** and is labelled as such. A page that tries
  to give the model instructions is expected; a page that succeeds is a
  vulnerability.
- **Text typed in the panel carries an origin marker** so the model can tell it
  apart from page content. A route into a prompt that bypasses the marker defeats
  the mechanism entirely.
- **The model cannot type into the panel**, cannot open a dialog the panel draws,
  and cannot press a button you have not offered it.

## Code execution: is there any

None. There is no `eval`, no `new Function`, no string passed to a timer, no
remote script, and no `document.write`. The panel's markup comes from a DOM helper
or from Markdown that is sanitized twice over:

1. **DOMPurify with a narrow allowlist** — no `img`, `iframe`, `script`, or `style`,
   and links restricted to `http`/`https` so a `javascript:` or `data:` URL cannot
   survive (`control/markdown.ts`).
2. **A content security policy** of `script-src 'self'`, which makes an inline
   script or an event-handler attribute impossible even if the first layer missed
   something (`manifest.json`, and the panel inlines nothing).

Icons are a static table of SVG paths selected by a typed union, not by a string
from anywhere else.

## Known limitations

Stated because a trust document that only lists strengths is marketing:

- **The bridge token is a bearer credential on loopback.** Anything already
  running as you on your machine can read it and use the bridge. This protects
  against a web page, not against local malware.
- **A loopback upgrade from the extension skips that token**, so discovery needs no
  setup. The exemption is bound to named extension ids (`extensionId`, a
  comma-separated list; the default names this repository's development id,
  `kdhkdgfcinfkmogifamoapmheihhcjfk`, and the id the Chrome Web Store assigned,
  `agpipnjijkpomaannkijkilggoffdiaf`), each matched against the exact `Origin`:
  another installed extension presenting its own `chrome-extension://…` origin is
  rejected, and so is a local process that sets the header to anything else. A
  process that knows a listed id can still forge the header — this narrows the
  exposure from "any extension" to "the listed ones plus anyone who copies an id",
  it does not eliminate it. Listing two ids rather than one does not widen that
  meaningfully: both are public, and each is a full 32-character id rather than a
  prefix. Set `extensionId: ''` to make the token mandatory on every connection.
- **Firefox always presents the token** (`moz-extension://` carries a per-install
  UUID rather than the manifest's stable Gecko id), so there is no token-free path
  for that browser.
- **A remote `bridgeUrl` is possible**, as described above.
- **The `data_collection_permissions` declaration for Firefox** lists
  `browsingActivity`, `websiteActivity`, `websiteContent` and
  `personalCommunications`. Those are accurate: the extension reads tab URLs and
  titles, reads page text including whatever happens to be on the page, and reads
  text you type into the panel. Firefox requires the broadest honest answer, not
  the narrowest arguable one.
- **A loopback extension also passes the privileged-method gate.** The bridge keeps
  `host.pickDirectory`, `host.openPath`, `settings.*` and `credentials.*` for
  loopback remotes only — and the extension is one, so those methods are reachable
  from it. The extension's own code calls only `session.*`, and the panel exposes no
  way to call anything else, but the channel can carry any method and the gate will
  not stop it. This is deliberate: a local extension running in the user's own
  browser is already inside the trust boundary, so treating it as remote would only
  break the useful calls. It is listed because it is a real capability rather than
  because it is a bug.
- **Approval prompts are per-site, not per-element.** Allowing a site allows
  acting anywhere on it.
