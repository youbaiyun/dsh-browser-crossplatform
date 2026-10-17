# Publishing to the stores

Steps that cannot be automated, in order, with the parts that most often go
wrong called out.

## Before anything else

Two things must be true or the submission is rejected immediately:

1. **No retired name may remain in the panel copy.** The text the browser shows
   comes from `extension/_locales/*/messages.json` and `extension/control/strings.ts`;
   `extension/tests/locales.spec.ts` fails if any locale still states one of the
   names in its `RETIRED` list (an old name shipped on the extensions page once,
   which is why that assertion exists). To read the current names yourself:
   `rg -i "crossplatform|browser control|手與眼" extension/_locales extension/control`.
2. **The name must not collide.** Upstream already holds `dsh Browser Control` on
   the Chrome Web Store. This build ships as `dsh Browser Extension`; the name
   comes from `extension/_locales/*/messages.json`, so change it
   there and rebuild rather than editing the built package.

## Build the upload package

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter dsh-browser-extension run package
```

> The two archives below are **built locally and are not committed** — a fresh clone
> will not contain them. The commands in the block above produce them.

`package` writes `dsh-browser-crossplatform-<version>.zip` and
`dsh-browser-crossplatform-<version>-firefox.zip` into the repository root, taking the
version from the manifest inside each build. Use it instead of zipping by hand: the
store rejects an archive whose entry names use `\` instead of `/`, and on Windows both
`Compress-Archive` and "send to → compressed folder" produce exactly that. The script
refuses such entries and fails loudly on a stale or mismatched `dist`.

The store wants a ZIP of the **contents** of `dist/`, not the folder itself; the
packer already lays the archive out that way (zipping the folder itself produces an
extra directory level and the upload fails as "manifest not found").

## Chrome Web Store

### 1. Developer account

One-time US$5 registration at
https://chrome.google.com/webstore/devconsole. The account email becomes public
on the listing, so use an address you are content to publish, or a dedicated
one.

### 2. Create the item and upload

Upload the ZIP. The dashboard reports the manifest's version. **Every upload must
have a higher version than the last**, so bump `version` in both
`extension/manifest.json` and `package.json` before re-uploading —
a rejected upload still consumes the number.

### 3. Fill in the listing

Everything needed is in this directory:

- `store-listing.md` — name, descriptions, category, single-purpose statement
- `permission-and-data-disclosure.md` — the answer for every permission and the host
  pattern, plus the data-usage form

### 4. Privacy policy URL

Required. This one exists already, created 2026-10-03 as a secret gist so it is
reachable by anyone with the link but is not searchable:

```
https://gist.github.com/youbaiyun/92cd701036f39f168548f12c5ed171f6
```

Contents are `PRIVACY.md`. Verified reachable **without authentication** — the
HTML page and the raw file both return HTTP 200, which is the property that
matters: a store reviewer is not signed in to anything of yours, and a private
gist or a private repository file would fail their check.

**If the policy text ever changes**, edit the gist rather than creating a new one.
The store stores the URL, not the text, so a new gist means an outdated URL in a
live listing. Secret gists keep their revision history, so an edit is both
traceable and sufficient.

### 5. Screenshots

At least one at 1280×800 or 640×400. Not produced yet. Take them with the panel
open, in this order of usefulness to someone deciding whether to install:

1. A conversation with a tool line — what it is, at a glance. This is the one the
   listing shows by default.
2. An approval card — evidence that it asks before acting. **Turn 「不再询问，直接操作」 off first**: it ships on, and while it is on no card is ever created, so a screenshot hunt will come up empty.
3. The settings sheet — evidence that the user keeps control.
4. `@open` having opened a page — the clearest single feature.
5. A page snapshot with numbered controls — how it reads a page without
   screenshots.

Stretch the browser window to at least 1280 wide before capturing, so the panel
and the page are both visible at the required size.

### 6. Submit for review

Reviews take days to weeks. The broad host permission (`http://*/*`,
`https://*/*`) is the usual cause of a longer review; the justification in
`permission-and-data-disclosure.md` is written to answer that specific concern, so give
it verbatim rather than paraphrasing.

## Firefox (addons.mozilla.org)

Separate submission, separate review.

```sh
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run package   # writes both archives, including the Firefox one
```

**AMO requires the source code as well as the build.** The submitted package contains
minified bundles, so the review form asks for a source archive plus instructions for reproducing
them. Chrome does not ask for this. Attach `dsh-browser-crossplatform-<version>-source.zip`,
built as below, and check that `SOURCE-BUILD.md` inside it still matches the real build
commands — it is the only thing the reviewer has to go on.

```sh
# source archive: the workspace minus what can be reinstalled or regenerated
#   include  extension/ packages/ package.json pnpm-workspace.yaml pnpm-lock.yaml
#            SOURCE-BUILD.md LICENSE README.md COPYRIGHT.md PRIVACY.md
#   exclude  node_modules/ dist*/ lib/ .git/ coverage/
```

Notes specific to Firefox:

- The add-on id in `manifest.firefox.json` must be yours. It is currently
  `dsh-browser-extension@youbaiyun.github.io`. **An id is permanent once submitted** —
  changing it later means a new listing, so confirm it before the first upload.
- Firefox declares `strict_min_version: 140.0`. The sidebar and
  `storage.session` this build uses need it.
- **The AMO compatibility range must be set by hand on every submission.** The form
  opens with its own default — observed as `0.3` for the minimum — and does not pick up
  the manifest's `strict_min_version`. Left alone it declares the add-on usable on
  Firefox 0.3, which is false, and the listing shows it. Set the **lower** dropdown to
  `140.0` and the **upper** one to `*` (the manifest declares no `strict_max_version`,
  so there is no ceiling). Note which box is which: the range reads
  `minimum — maximum`, and the first attempt at this corrected the maximum instead,
  producing "Firefox 0.3 to 140.0" — which excludes every current release.
- The manifest carries no `sidePanel` permission, which is correct: Firefox has
  no such API and uses `sidebar_action` instead.
- Firefox always presents the bridge's bearer token: its Origin is
  `moz-extension://<per-install-uuid>`, which is not a stable identity, so it
  cannot use the token-free loopback shortcut that Chrome uses. Nothing to
  configure — the extension sends the token it was given.

## After publishing

- **Tag the release.** `git tag v0.38.7 && git push --tags` matches the manifest
  version to a point in history, which is the only way to answer "what exactly is
  in the store?" later.
- **Keep the version in one place in your head.** Seven files carry one version — the
  root `package.json`, `packages/protocol/package.json`, `packages/bridge/package.json`,
  `extension/package.json`, `benchmark/package.json`, and both manifests. They move together, and
  `extension/tests/versions.spec.ts` fails if any of them drifts; the packaging script
  also names each archive after the manifest inside it.
- **Watch the first reviews.** The panel's behaviour is unusual by design (no
  screenshots, the approval switch on by default, a text-only page channel). If users read
  that as a limitation rather than a choice, the listing description is the thing
  to fix, not the extension.
