# Chrome Web Store submission — the form, field by field

One page to fill the dashboard from. Every value below is copy-paste ready, and
where a field has a limit the count is given.

Sources this was compiled from: `store-listing.md` (the copy),
`permission-and-data-disclosure.md` (the permission answers), `publishing-steps-and-pitfalls.md` (the
process). If a value here disagrees with those, they win and this file is stale.

## Before you start

| Thing | Where it is | Note |
|---|---|---|
| The archive to upload | `dsh-browser-crossplatform-0.38.6-store.zip` (repo root once built, ~100 KB; Firefox: `…-0.38.6-store-firefox.zip`) | Built by `pnpm --filter dsh-browser-extension run package`, which names each archive after the manifest inside it and refuses `\` entry names — the store rejects an archive whose entries are not `/`-separated. It needs **both** targets built (`dist/` and `dist-firefox/`) and fails if their versions disagree, so run `build` and `build:firefox` first |
| Store icon 128×128 | `extension/dist/assets/icons/icon128.png` | |
| Screenshots | not produced yet; no `screenshots/` directory exists in this tree | The dashboard wants 1280×800 or 640×400, 1–5 images. Upload through the dashboard rather than committing them here |
| Privacy policy URL | the public URL serving `PRIVACY.md` | The gist already used is fine — update its body to `PRIVACY.md`. Verified reachable without login |
| Homepage URL | `https://github.com/youbaiyun/dsh-browser-crossplatform` | |
| Support URL | `https://github.com/youbaiyun/dsh-browser-crossplatform/issues` | |

---

## 1. Store listing

### Name (75 characters max)

```
dsh 浏览器扩展（全平台）
```

The dashboard is in Chinese, so submit the Chinese name as the primary locale.
English (`dsh Browser Extension`) belongs in the English listing if you add one.

### Short description (132 characters max)

```
Browser executor for the dsh desktop app: reads and operates your page, signed in, no screenshots. Image look-up: deepseek-flash.
```

That is 129 characters, and it is asserted equal to `_locales/en` by
`extension/tests/locales.spec.ts` rather than counted by hand — so it must be copied
from `store-listing.md` verbatim. A differently-worded string of a similar length
fails that assertion (and the store compares the listing with the manifest's
description, which comes from `_locales/en`). The Chinese equivalent, if you switch
the listing language:

```
dsh 桌面端的浏览器执行器：模型以文本读取并操作你正在用的页面，保留登录态，不截图；看图功能可选，会把图交给桌面端配置的模型（默认 deepseek-flash）。
```

That is 83 characters, and it is the `_locales/zh_CN` string word for word.

### Detailed description

Use the Chinese block from `store-listing.md`, which begins
`全平台 DeepSeek Harness 浏览器插件` and ends with the upstream credit line. It is
written so that the first three lines alone tell someone whether they want it.

**One thing in it must stay**: the line saying the desktop app is required. Without
it, people install the extension, find it says 未连接, and leave a one-star review.

### Category

```
Productivity
```

### Language

```
Chinese (Simplified)
```

Add English as a second locale only if you also write an English listing; a
half-translated listing reads as neglected.

---

## 2. Graphic assets

| Field | Value |
|---|---|
| Store icon | `icon128.png` from the archive folder above |
| Screenshots | 1–5 at 1280×800 (640×400 also accepted). None exist in the repository yet — capture them from a real session and upload them in the dashboard. The first one is what the listing shows by default |
| Small promo tile (440×280) | optional; skip unless you want the extra placement |

Suggested screenshot order, and what each has to show:

1. **A conversation with a tool line** — the page on the left, the panel on the
   right, a question, an answer, one tool call. This is the one that says what the
   extension is.
2. **An approval card** — the ask, the target element, and the allow/deny buttons. **First turn 「不再询问，直接操作」 off**: the switch ships on, so nothing asks until it is off.
   Evidence that it does not act on its own.
3. **The settings sheet** — evidence that the user keeps control.
4. **`@open` having opened a page** — the clearest single feature.
5. **A snapshot** — numbered controls, to show how a page is read without
   screenshots.

---

## 3. Privacy

### Privacy policy URL

```
https://gist.github.com/youbaiyun/92cd701036f39f168548f12c5ed171f6
```

### Single purpose description (required)

```
Operate the browser tab the user selects, on behalf of the dsh desktop app running on the same machine.
```

### Justification for each permission

Copy each paragraph from `permission-and-data-disclosure.md` into the matching field.
The dashboard asks once per permission:

| Permission | The argument to give |
|---|---|
| `sidePanel` | the conversation interface *is* the panel; there is no popup and no separate tab |
| `storage` | remembers the bridge address and token, the user's preferences, and the image-description memo (24 h, 200 entries) — the full wording is in `permission-and-data-disclosure.md` |
| `tabs` | lists open tabs so the user can choose one, keeps tools bound to it, opens a tab on request |
| `scripting` | injects the page reader and the action executor into the selected tab |
| `webNavigation` | detects a finished navigation so the next read sees the settled page |
| `alarms` | keeps the loopback connection alive across MV3 worker suspension |
| `notifications` | raises an approval when no panel is open, so a pending decision is not lost |

**Do not mention `activeTab`.** It was removed from the manifest in this release;
explaining a permission you do not request invites a question you cannot answer.

### Host permission (`http://*/*`, `https://*/*`)

This is the field most likely to draw a human reviewer, so give the argument in
full rather than a summary:

> The extension operates the page the user is looking at, and that page is not
> known when the manifest is written — the user may be on any site. No narrower
> pattern would work: a fixed domain list would break the feature everywhere else.
>
> What limits it: the content script only reads and acts on the tab the user
> explicitly selects; reading and acting are separate operations, and approval can be
> turned on (it ships on, so a new install acts without a per-action prompt); passwords
> and payment-card values are replaced in place and never
> leave the page; page text is labelled as untrusted input so a page cannot issue
> instructions that look like the user's.

### Data usage disclosure

On Chrome, tick **only** website content:

- Personally identifiable information — **not collected**
- Authentication information — **not collected** (the bridge token is generated by
  the desktop app and stored locally by the browser)
- Web history — **not collected**
- Website content — **read**, at the user's direction, and sent to the model the
  user configured. This is the extension's function
- User activity — **not collected**
- Location — **not collected**

**Firefox is a different form, and the manifest already answers it.** AMO reads
`browser_specific_settings.gecko.data_collection_permissions.required` and this build
declares four:

```
browsingActivity, personalCommunications, websiteActivity, websiteContent
```

Those are accurate, not over-declared — the extension reads tab URLs and titles
(`browsingActivity`, `websiteActivity`), reads whatever text is on the page
(`websiteContent`), and reads what you type into its own panel
(`personalCommunications`) — and AMO requires the broadest honest answer rather than
the narrowest arguable one. Do **not** copy Chrome's single tick into the AMO form:
the two are graded separately, and a mismatch between the form and the manifest is
what gets a submission bounced. The Chrome form's categories have no equivalent for
"communications", which is why the two forms legitimately differ.

Then certify all three required statements: the data is not sold, not used for
purposes unrelated to the single purpose, and not used to determine
creditworthiness or for lending.

---

## 4. Distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Regions | All |
| Pricing | Free |

---

## 5. Submit

`Submit for review`. Then:

- A review takes days to weeks. The broad host permission is the usual reason for
  the longer end, which is why the justification above is written to answer that
  concern specifically — give it verbatim rather than paraphrasing.
- **The version number must be higher than the last submitted one, and a rejection
  still consumes it.** Before a resubmission, raise the version in **all seven** places
  together: the root `package.json`, `packages/protocol/package.json`,
  `packages/bridge/package.json`, `extension/package.json`,
  `benchmark/package.json`, and both manifests.
  `extension/tests/versions.spec.ts` asserts all seven agree — following a shorter list
  leaves the suite red — and the packaging script names each archive after the
  manifest inside it. Then rebuild.
- The published store version is `0.3.1`. This build is `0.38.6` — a rewrite that adds image
  recognition, the panel work, and the identity-bound loopback shortcut — so the next
  submission is `0.38.6`, not `0.3.2`.
