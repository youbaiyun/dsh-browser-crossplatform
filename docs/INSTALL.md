> 中文版见 [INSTALL.zh.md](INSTALL.zh.md)
# Installation (just follow along)

Once installed you get: **the dsh desktop app reads the very page you are looking at**, and then it clicks, types, scrolls and turns pages for you.

The whole installation has **two parts**:

| What to install | Where it comes from | What it is |
|---|---|---|
| **The extension** (the browser side) | Browser extension store | The side panel you see in your browser |
| **The bridge plugin** (the desktop side) | npm, one command | Lets dsh talk to the extension, and provides the `browser_*` tools |

With both parts installed, the extension panel finds the desktop on its own: the token is generated automatically, and **you do not need to fill it in by hand**.

> **The one order that matters: install the extension *first*, in the browser you actually use.**
> Everything else can be fixed afterwards, but if the extension is not installed in that browser
> there is no way for anything — including the desktop app — to put it there. The desktop can
> start your browser, and it will tell you (and open) the right extensions page when that is what
> is missing, but it cannot install the extension for you: a browser only loads an extension it
> has been told to install. Since Chrome 137 the branded Chrome and Edge builds ignore the
> `--load-extension` command-line flag outright, and even where a browser still honours it
> (Chromium, Chrome for Testing) that load lasts a single session and installs nothing.

**Compatibility range**: **Windows, macOS and Linux are all supported** (for Linux, CI runs the full chain on every commit); dsh desktop (Node ≥ 20) with desktop Chrome / Chromium / Edge **116+** or Firefox **140+**; **phones and tablets are not supported** (there is no side panel UI, and the bridge keeps its token-free path and privileged methods on loopback).

For the complete minimum versions and where each number comes from, see "Compatibility range" in the repository README.
**Phones and tablets are not supported**: there is no side panel UI on those platforms, and extension stores do not support installing third-party extensions; and because the bridge keeps its token-free path and privileged gateway methods on loopback, a phone could not reach the `127.0.0.1` on your computer anyway.

---

## Step 1: install the extension

Open your browser's extension store page, click "Add to Chrome / Add to Firefox", and confirm.

> ⚠️ When the store version is **not yet published** (under review), it cannot be found in the store. Until then, only developers can install it:
> open "Developer mode" at `chrome://extensions` → "Load unpacked" → select **the folder that
> contains `manifest.json`** (in a checkout that is `extension/dist`; from a Release download,
> unzip `dsh-browser-crossplatform-<version>.zip` and select the unzipped folder).
>
> **Use the archive without `-store` in its name.** The `-store` build is the one you upload; its
> manifest has **no `key`**, so side-loading it gives the extension an id that is *not* on the
> bridge's allowlist — the connection is refused and the panel stays 「未连接」. The plain build
> carries `key`, so its id is fixed and already allowed, and it connects with no token.
>
> Regular users should wait until it is listed in the store before installing.

**It has to be the browser you actually use.** The extension is per-profile: installing it in one
browser or one Chrome profile does nothing for another. If your default browser is Chrome but the
extension is only in Edge, the desktop will connect to neither, and it will say so.

## Step 2: install the bridge plugin (one command)

In a terminal that can run dsh:

```sh
dsh plugin --profile desktop add dsh-browser-crossplatform
```

**The profile name must match the one you actually use**: dsh **desktop** uses `desktop`; the command-line `dsh web` uses `web`.
(If unsure, check the directory names under `~/.dsh/profiles/`.)

After installing, **restart dsh once**. After the restart, the bridge plugin's settings page appears, titled 「**dsh 浏览器扩展（全平台）的桌面端一半**」.

## Step 3: confirm it is installed (30 seconds)

```
1. Open any web page
2. Open dsh's browser side panel
3. The top of the panel should show **connected** (not "not connected")
4. Have the model read the page once: it will name the title and the buttons/links on it
```

All four check out → **it is installed**

## Step 4 (optional): let the model view images

Image viewing is **off by default** (once enabled, each image viewed costs roughly one extra second, and the image leaves this machine to be sent to the model you configured).

If you want to enable it, first make sure the desktop can obtain a key; pick one of the two options:

```
· Provide DEEPSEEK_API_KEY in the desktop's credential store (recommended: the key is never written to a file)
· Or enter the image-viewing API key (visionApiKey) on the bridge plugin's settings page
```

Then pick a level in the panel's "image viewing": low describes what is in the image; standard also cross-checks it against the page text; enhanced also asks what the image is doing on the page.
When you no longer need it, switch it back off.

---

## If it will not install, check in this order

| Symptom | Most likely cause |
|---|---|
| The panel keeps showing "not connected" | Step 2 was not done, or **dsh was not restarted** afterwards |
| 「dsh 浏览器扩展（全平台）的桌面端一半」 is not listed in the plugin settings page | The `--profile` name is not the one your desktop uses |
| The panel connects, but the model says the page is empty | Try refreshing the page once and reading it again (restricted pages such as `chrome://` cannot be read; that is normal) |
| Image viewing is enabled but it reports unavailable | The key from step 4 has not been configured yet |

## Uninstallation

```
dsh plugin --profile desktop remove dsh-browser-crossplatform     # the bridge plugin
browser extension page → remove                                   # the extension
```

---

## FAQ

### How do I install the dsh browser extension?

Both parts must be installed: the extension from the browser extension store, and the bridge plugin with the single command
`dsh plugin --profile desktop add dsh-browser-crossplatform`, then restart dsh. See steps 1 and 2 above for details.

### After installing, how do I confirm it works?

Open any web page and open dsh's browser side panel: the top shows **connected**, and having the model read the page once lets it report the title and the buttons —
that counts as installed. For the four self-checks, see step 3 above.

### Which platforms does the dsh browser extension support?

The dsh desktop on Windows / macOS / Linux, with desktop Chrome / Chromium / Edge 116+ or Firefox 140+.
Phones and tablets are not supported (there is no side panel UI, and the bridge keeps its token-free path and privileged methods on loopback).

### Why does the panel keep showing "not connected"?

In this order:

1. **The extension is not installed in the browser you are using.** This is the most common one, and
   the desktop cannot fix it for you — see the note at the top of this page. Check the browser's
   extensions page (`chrome://extensions`, `edge://extensions`): if the extension is not listed,
   nothing else will work. It is per-profile, so an install in a different browser or Chrome profile
   does not count.
2. **The bridge plugin is not installed yet** (step 2), or **dsh was not restarted** after installing it.
3. **The extension is installed but disabled**, or was disabled by Chrome for running as an unpacked
   build. Enable it on the extensions page.
4. **The extension's id is not in the bridge's allow-list**, so the token-free loopback connection is
   refused and the socket closes with code `4002` (`bad token`). This is what a version mismatch looks
   like: `extensionId` in the bridge config defaults to the ids this project knows, and an extension
   built from other sources has a different one. It is invisible from the panel — the status stays
   "not connected" — so the fix is either to install the extension from the store, or to add that
   build's id to `extensionId` (visible at `chrome://extensions`, comma-separated for several).

### The browser was closed, and the model said it could not open it

That is expected the first time: the browser only loads the extension if it is installed in it.
Start your browser yourself, install the extension once (step 1), and from then on the desktop can
start the browser for you — it opens **the browser you already use**, with no extra flags, and it
refuses to open a second window while that browser is already running with one. When the extension turns out
not to be installed anywhere, it says so and opens the right extensions page for you.

### Do I need to find the token myself?

**Chrome / Edge: no.** On first startup the bridge generates a token and stores it in
`~/.dsh/ext-bridge-token` (permissions 0600), and the extension never needs to see it:
a loopback connection coming from **this** extension (matched by its id, `extensionId`
in the plugin config) is accepted without one. That is why discovery needs no setup.

**Firefox: yes, once.** Firefox always presents the token, because its
`moz-extension://` origin carries a per-install UUID rather than a stable add-on
identity, so the bridge cannot tell that the connection really is this extension and
requires the credential. The extension has no way to read that file by itself, and the
panel has no field for it — the address and the token were deliberately removed from the
settings sheet, because on the supported path neither is the user's decision to make. So
on Firefox the token is written into the extension's own storage once, from the side
panel's DevTools console:

```js
chrome.storage.local.get('dshSettings').then(({ dshSettings }) =>
  chrome.storage.local.set({ dshSettings: { ...dshSettings, token: '<contents of ~/.dsh/ext-bridge-token>' } }))
```

Then **reload the extension**: settings are read once at startup and there is no
`storage.onChanged` listener, so a console write is not picked up until it reloads. It is
remembered from that point on.
